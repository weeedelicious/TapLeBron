import { createFile, MP4BoxStream } from 'mp4box';
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import { mapBlend, mapDuplicateSource } from '../elements/VideoElement.js';
import { VideoFrameDecoder, demuxAudio } from './VideoFrameDecoder.js';
import { WebGLFrameRenderer } from './WebGLFrameRenderer.js';
import { generateIntermediateFrameAI, checkAISupport } from '../utils/AIOpticalFlow.js';

// AI光流是否可用（缓存）
let aiSupported = null;

/**
 * 计算两帧之间的运动差异（0~1，越大运动越快）
 */
async function computeMotionDiff(prevFrame, nextFrame) {
  // 缩放到小尺寸计算，速度快
  const w = 64;
  const h = 36;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  
  ctx.drawImage(prevFrame, 0, 0, w, h);
  const prevData = ctx.getImageData(0, 0, w, h).data;
  
  ctx.drawImage(nextFrame, 0, 0, w, h);
  const nextData = ctx.getImageData(0, 0, w, h).data;
  
  let sum = 0;
  const step = 4; // 每4个像素采样一次，更快
  for (let i = 0; i < prevData.length; i += step * 4) {
    const dr = Math.abs(prevData[i] - nextData[i]);
    const dg = Math.abs(prevData[i + 1] - nextData[i + 1]);
    const db = Math.abs(prevData[i + 2] - nextData[i + 2]);
    sum += (dr + dg + db) / 3;
  }
  
  const count = prevData.length / (step * 4);
  const avgDiff = sum / count / 255; // 归一化到 0~1
  return avgDiff;
}

/**
 * 视频导出器
 * WebCodecs H.264 编码，再用 MP4Box 写成非分片的标准 MP4。
 * 时长、分辨率、帧率、码率写在 mvhd / tkhd / stts / btrt 里，
 * Windows 属性面板可以读到。
 */
export class VideoExporter {
  constructor() {
    this.decoder = new VideoFrameDecoder();
    this.supported = typeof VideoEncoder !== 'undefined';
  }

  /**
   * MP4/MOV 走硬解流水线；其它格式仍逐帧取样。
   * @param {import('../elements/VideoElement.js').VideoElement} videoElement
   * @param {{ mode?: string, targetFps?: number, bitrate?: number, onProgress?: (progress: number) => void }} [options]
   * @returns {Promise<Blob>}
   */
  async export(videoElement, options = {}) {
    if (canUseHardwarePipeline(videoElement)) {
      for (const acceleration of ['prefer-hardware', 'prefer-software']) {
        try {
          return await this.exportHardware(videoElement, options, acceleration);
        } catch (error) {
          if (error?.name === 'AbortError') throw error; // 用户终止，不再回退
          // 只在「准备阶段」失败（解码器/编码器还没开始产帧）才回退；
          // 转码已开始后失败直接报错，绝不重跑一遍（4K 重跑 = 双倍时间，不符合生产）
          if (!error?.early) throw error;
          console.warn(`[导出] ${acceleration} 准备阶段失败，改试下一种`, error);
        }
      }
    }
    console.warn('[导出] 硬解不可用，改用逐帧导出');
    return this.exportSeek(videoElement, options);
  }

  /** 抛出 AbortError，供 ESC 终止导出时使用 */
  abortError() {
    return new DOMException('导出已取消', 'AbortError');
  }

  /**
   * 硬解码、渲染、硬编码并行推进。帧复制直接复用解码帧，不做读回。
   * @param {import('../elements/VideoElement.js').VideoElement} videoElement
   * @param {{ mode?: string, targetFps?: number, bitrate?: number, onProgress?: (progress: number) => void }} options
   */
  async exportHardware(videoElement, options, acceleration = 'prefer-hardware') {
    const {
      mode = 'duplicate',
      targetFps = 30,
      bitrate = 5_000_000,
      format = 'mp4',
      signal = null,
      onProgress = () => {}
    } = options;

    const width = Math.max(2, videoElement.width & ~1);
    const height = Math.max(2, videoElement.height & ~1);
    const duration = videoElement.video.duration;
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error('视频时长无效，无法导出');
    }

    const totalFrames = Math.max(1, Math.round(duration * targetFps));
    const originalFps = videoElement.originalFps || 24;
    const clampTime = (time) => Math.min(Math.max(0, time), Math.max(0, duration - 0.04));

    onProgress(0.02);
    console.log('[导出] 开始硬解流水线');
    let session = null;
    let renderer = null;
    let encoder = null;
    const samples = [];
    const pendingCopies = [];
    let description = null;
    let encodeError = null;
    try {
      // 准备阶段：打开解码器、创建渲染器、探测编码器配置。
      // 此阶段失败标记 early=true，允许上层回退到软解；一旦开始产帧就不再重跑。
      session = await this.decoder.open(videoElement.sourceFile, acceleration);
      onProgress(0.08);
      console.log(`[导出] 开始转码，共 ${totalFrames} 帧`);
      renderer = new WebGLFrameRenderer(width, height);
      const encoderConfig = await pickAvcConfig(width, height, bitrate, targetFps);

      encoder = new VideoEncoder({
        output: (chunk, metadata) => {
          if (metadata?.decoderConfig?.description) {
            description = new Uint8Array(metadata.decoderConfig.description).slice().buffer;
          }
          const data = new Uint8Array(chunk.byteLength);
          samples.push({ data, isSync: chunk.type === 'key' });
          pendingCopies.push(Promise.resolve(chunk.copyTo(data)));
        },
        error: (error) => {
          encodeError = error;
        }
      });
      encoder.configure(encoderConfig);
    } catch (error) {
      // 准备阶段失败：清理已建资源后抛出，标记 early 允许上层回退（此时还没开始产帧）
      if (encoder && encoder.state !== 'closed') {
        try { encoder.close(); } catch (e) { /* 忽略 */ }
      }
      if (session) session.close();
      if (renderer) renderer.destroy();
      error.early = true;
      throw error;
    }

    try {
      for (let i = 0; i < totalFrames; i++) {
        if (signal?.aborted) throw this.abortError();
        if (encodeError) break;
        const outputTime = i / targetFps;
        const timestamp = Math.round(outputTime * 1_000_000);
        const frameDuration = Math.round(1_000_000 / targetFps);
        let encoded;

        if (mode === 'optical') {
          // AI光流模式：自适应切换——运动小用原帧，运动大用AI插值
          if (aiSupported === null) {
            aiSupported = await checkAISupport();
            console.log(`[导出] AI光流支持: ${aiSupported}`);
          }
          
          const { frameIndex, alpha } = mapBlend(i, originalFps, targetFps);
          const prev = await session.frameAtTime(clampTime(frameIndex / originalFps));
          const next = alpha > 0
            ? await session.frameAtTime(clampTime((frameIndex + 1) / originalFps))
            : null;
          
          if (aiSupported && next && alpha > 0) {
            // 计算运动幅度
            const motionDiff = await computeMotionDiff(prev, next);
            const useAI = motionDiff > 0.25; // 阈值再调高：只有中等运动才用AI，太大太小都用原帧
            console.log(`[导出] 运动幅度: ${motionDiff.toFixed(3)}，用AI: ${useAI}`);
            
            if (useAI) {
              // 运动大：用AI光流插值
              try {
                const prevBitmap = await createImageBitmap(prev);
                const nextBitmap = await createImageBitmap(next);
                const intermediate = await generateIntermediateFrameAI(prevBitmap, nextBitmap, alpha);
                renderer.renderFrame(intermediate);
                encoded = renderer.capture(timestamp, frameDuration);
                prevBitmap.close();
                nextBitmap.close();
              } catch (e) {
                console.warn('[导出] AI光流失败，降级到帧复制：', e);
                renderer.renderFrame(prev);
                encoded = renderer.capture(timestamp, frameDuration);
              }
            } else {
              // 运动小：直接用最近的原帧（100%清晰，无模糊）
              renderer.renderFrame(alpha < 0.5 ? prev : next);
              encoded = renderer.capture(timestamp, frameDuration);
            }
          } else {
            // 不需要插值，直接用原帧
            renderer.renderFrame(prev);
            encoded = renderer.capture(timestamp, frameDuration);
          }
          session.releaseBefore(frameIndex / originalFps);
        } else if (mode === 'blend') {
          const { frameIndex, alpha } = mapBlend(i, originalFps, targetFps);
          const prev = await session.frameAtTime(clampTime(frameIndex / originalFps));
          const next = alpha > 0
            ? await session.frameAtTime(clampTime((frameIndex + 1) / originalFps))
            : null;
          renderer.renderBlend(prev, next, alpha);
          encoded = renderer.capture(timestamp, frameDuration);
          session.releaseBefore(frameIndex / originalFps);
        } else {
          const sourceTime = clampTime(mode === 'duplicate'
            ? mapDuplicateSource(i, originalFps, targetFps) / originalFps
            : outputTime);
          const source = await session.frameAtTime(sourceTime);
          if (source.displayWidth === width && source.displayHeight === height) {
            encoded = new VideoFrame(source, { timestamp, duration: frameDuration });
          } else {
            renderer.renderFrame(source);
            encoded = renderer.capture(timestamp, frameDuration);
          }
          session.releaseBefore(sourceTime);
        }

        encoder.encode(encoded, { keyFrame: i % (targetFps * 2) === 0 });
        encoded.close();

        const queueStarted = performance.now();
        while (encoder.encodeQueueSize > 6) {
          if (performance.now() - queueStarted > 10000) {
            throw new Error('编码器队列卡住');
          }
          await yieldThread();
        }
        if (i % 30 === 0) {
          const progress = 0.08 + 0.88 * (i / totalFrames);
          onProgress(progress);
          console.log(`[导出] 转码进度 ${Math.round(progress * 100)}%`);
          await yieldThread();
        }
      }

      if (signal?.aborted) throw this.abortError();
      console.log('[导出] 等待编码器收尾');
      // 4K 视频编码 flush 较慢，超时按 60s 兜底
      await withTimeout(encoder.flush(), 60000, '编码器收尾超时（4K 视频编码较慢，请耐心等待）');
      await Promise.all(pendingCopies);
      if (signal?.aborted) throw this.abortError();
      console.log('[导出] 开始封装 MP4');
    } finally {
      if (encoder.state !== 'closed') encoder.close();
      session.close();
      renderer.destroy();
    }

    if (encodeError) throw new Error(`编码失败: ${encodeError.message}`);
    if (!description) throw new Error('编码器没有返回 H.264 配置，无法写入 MP4');
    if (samples.length !== totalFrames) {
      throw new Error(`编码帧数不完整: ${samples.length}/${totalFrames}`);
    }

    onProgress(1);
    const buffer = buildProgressiveMp4({
      samples,
      description,
      width,
      height,
      fps: targetFps,
      bitrate,
      format,
      audio: session.audio || null
    });
    return new Blob([buffer], { type: format === 'mov' ? 'video/quicktime' : 'video/mp4' });
  }

  /**
   * 按画布预览的同一套帧率映射，逐帧取样后导出 30fps MP4。
   * @param {import('../elements/VideoElement.js').VideoElement} videoElement
   * @param {{ mode?: string, targetFps?: number, bitrate?: number, format?: string, onProgress?: (progress: number) => void }} [options]
   * @returns {Promise<Blob>}
   */
  async exportSeek(videoElement, options = {}) {
    if (!this.supported) {
      throw new Error('当前浏览器不支持WebCodecs API，请使用Chrome/Edge浏览器');
    }

    const {
      mode = 'duplicate',
      targetFps = 30,
      bitrate = 5_000_000,
      format = 'mp4',
      signal = null,
      onProgress = () => {}
    } = options;

    const width = Math.max(2, videoElement.width & ~1);
    const height = Math.max(2, videoElement.height & ~1);
    const duration = videoElement.video.duration;
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error('视频时长无效，无法导出');
    }

    const totalFrames = Math.max(1, Math.round(duration * targetFps));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: false });

    const encoderConfig = await pickAvcConfig(width, height, bitrate, targetFps);
    const samples = [];
    const pendingCopies = [];
    let description = null;
    let encodeError = null;

    const encoder = new VideoEncoder({
      output: (chunk, metadata) => {
        if (metadata?.decoderConfig?.description) {
          const source = new Uint8Array(metadata.decoderConfig.description);
          description = source.slice().buffer;
        }
        const data = new Uint8Array(chunk.byteLength);
        samples.push({
          data,
          isSync: chunk.type === 'key'
        });
        pendingCopies.push(Promise.resolve(chunk.copyTo(data)));
      },
      error: (error) => {
        encodeError = error;
      }
    });

    encoder.configure(encoderConfig);

    try {
      for (let i = 0; i < totalFrames; i++) {
        if (signal?.aborted) throw this.abortError();
        if (encodeError) break;

        await videoElement.renderFrameAtTime(ctx, i / targetFps, mode);
        const frame = new VideoFrame(canvas, {
          timestamp: Math.round((i * 1_000_000) / targetFps),
          duration: Math.round(1_000_000 / targetFps)
        });
        encoder.encode(frame, { keyFrame: i % (targetFps * 2) === 0 });
        frame.close();

        const queueStarted = performance.now();
        while (encoder.encodeQueueSize > 8) {
          if (performance.now() - queueStarted > 10000) {
            throw new Error('编码器队列卡住');
          }
          await yieldThread();
        }
        if (i % 5 === 0) {
          onProgress(i / totalFrames);
          await yieldThread();
        }
      }

      if (signal?.aborted) throw this.abortError();
      await encoder.flush();
      await Promise.all(pendingCopies);
      if (signal?.aborted) throw this.abortError();
    } finally {
      if (encoder.state !== 'closed') encoder.close();
    }

    if (encodeError) {
      throw new Error(`编码失败: ${encodeError.message}`);
    }
    if (!description) {
      throw new Error('编码器没有返回 H.264 配置，无法写入 MP4');
    }
    if (samples.length !== totalFrames) {
      throw new Error(`编码帧数不完整: ${samples.length}/${totalFrames}`);
    }

    onProgress(1);
    // 音频透传混流（源文件有音频轨时带上声音）
    let audio = null;
    try {
      if (videoElement.sourceFile) {
        const buf = await videoElement.sourceFile.arrayBuffer();
        buf.fileStart = 0;
        audio = await demuxAudio(buf);
      }
    } catch (err) {
      console.warn('[导出] 音频提取失败（继续视频导出）:', err.message);
      audio = null;
    }
    const buffer = buildProgressiveMp4({
      samples,
      description,
      width,
      height,
      fps: targetFps,
      bitrate,
      format,
      audio
    });
    return new Blob([buffer], { type: format === 'mov' ? 'video/quicktime' : 'video/mp4' });
  }

  /**
   * @param {Blob} blob
   * @param {string} [filename]
   */
  download(blob, filename = 'output_30fps.mp4') {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  /**
   * 保存到本地盘：优先弹系统保存对话框让用户选择真实落点；
   * 浏览器不支持 File System Access API、或对话框挂起超时（8s）时回退为普通下载。
   * @param {Blob} blob
   * @param {string} filename
   * @param {{ mime?: string }} [options]
   * @returns {Promise<{name: string, usedPicker: boolean, cancelled: boolean, fallbackToDownload?: boolean}>}
   */
  async saveToDisk(blob, filename = 'output_30fps.mp4', options = {}) {
    const mime = options.mime || blob.type || 'video/mp4';
    const ext = (filename.includes('.') ? '.' + filename.split('.').pop().toLowerCase() : '.mp4');
    if (typeof window.showSaveFilePicker === 'function') {
      let fallbackTriggered = false;
      const pickerPromise = (async () => {
        const handle = await window.showSaveFilePicker({
          suggestedName: filename,
          types: [
            {
              description: '视频文件',
              accept: { [mime]: [ext] }
            }
          ]
        });
        const writable = await handle.createWritable();
        if (fallbackTriggered) {
          // 超时已触发下载回退，用户又在框里确认：关闭流避免重复写
          await writable.close().catch(() => {});
          return { name: handle.name, usedPicker: true, cancelled: true };
        }
        await writable.write(blob);
        await writable.close();
        return { name: handle.name, usedPicker: true, cancelled: false };
      })();
      const timeoutGuard = new Promise((resolve) => {
        setTimeout(() => resolve({ timedOut: true }), 8000);
      });
      const result = await Promise.race([pickerPromise, timeoutGuard]);
      if (result.timedOut) {
        // 系统保存框挂起（内嵌浏览器/WebView 常见），回退普通下载并明确告知
        fallbackTriggered = true;
        this.download(blob, filename);
        return { name: filename, usedPicker: false, cancelled: false, fallbackToDownload: true };
      }
      return result;
    }
    this.download(blob, filename);
    return { name: filename, usedPicker: false, cancelled: false, fallbackToDownload: true };
  }
}

function canUseHardwarePipeline(videoElement) {
  const file = videoElement?.sourceFile;
  if (!file || typeof VideoDecoder === 'undefined') return false;
  const type = file.type || '';
  return type === 'video/mp4' || type === 'video/quicktime' || /\.(mp4|m4v|mov)$/i.test(file.name || '');
}

async function pickAvcConfig(width, height, bitrate, framerate) {
  const pixels = width * height;
  // 码率自适应（bitrate<=0 时按行业标准估算，避免糊掉）：
  // 基准按 30fps 计算，再乘以帧率比例系数——帧率越高，总码率按比例提高，
  // 确保每帧分到的比特数不变（DaVinci Resolve / Premiere 行业标准做法）
  let effectiveBitrate = bitrate;
  if (!effectiveBitrate || effectiveBitrate <= 0) {
    // 按分辨率的基准码率（30fps 基准，提高码率保证画质）
    let baseBitrate;
    if (pixels >= 3840 * 2160 * 0.75) baseBitrate = 50_000_000;   // 4K
    else if (pixels >= 1920 * 1080 * 0.75) baseBitrate = 20_000_000; // 1080p
    else if (pixels >= 1280 * 720 * 0.75) baseBitrate = 12_000_000;  // 720p
    else baseBitrate = 8_000_000;                                      // 更小
    // 帧率比例系数：相对于 30fps 基准，帧率越高码率越高
    const fpsFactor = Math.max(0.8, framerate / 30);
    effectiveBitrate = Math.round(baseBitrate * fpsFactor);
    console.log(`[导出] 自动码率：${Math.round(effectiveBitrate / 1e6)}Mbps（${width}×${height} @ ${framerate}fps，基准${Math.round(baseBitrate/1e6)}M × ${fpsFactor.toFixed(2)}）`);
  }
  const level = pixels > 1920 * 1088 ? '33' : pixels > 1280 * 720 ? '28' : '20';
  const candidates = [
    `avc1.4D00${level}`,
    `avc1.6400${level}`,
    'avc1.42E01E',
    'avc1.42001F'
  ];
  const accelerations = ['prefer-hardware', 'no-preference'];

  for (const hardwareAcceleration of accelerations) {
    for (const codec of candidates) {
      const config = {
        codec,
        width,
        height,
        bitrate: effectiveBitrate,
        framerate,
        // 去掉 latencyMode: 'realtime'，默认高质量编码
        hardwareAcceleration,
        avc: { format: 'avc' }
      };
      const support = await VideoEncoder.isConfigSupported(config);
      if (support.supported) return support.config || config;
    }
  }
  throw new Error('当前浏览器无法编码 H.264');
}

/**
 * 用 mp4-muxer 封装 MP4（行业标准方案，Clipchamp/PinePaper 同款）。
 * 自动处理 esds、采样率、声道数、stbl、moov 位置，不再手动拼 MP4 结构。
 * @param {{ samples: { data: Uint8Array, isSync: boolean }[], description: ArrayBuffer, width: number, height: number, fps: number, bitrate: number, format?: string, audio?: { samples: { data: Uint8Array, duration: number }[], samplerate: number, channels: number, codec?: string } | null }} input
 * @returns {ArrayBuffer}
 */
export function buildProgressiveMp4(input) {
  const { samples, description, width, height, fps, bitrate, format = 'mp4', audio = null } = input;

  const hasAudio = audio && audio.samples && audio.samples.length;
  const sr = hasAudio ? (audio.samplerate || 48000) : 48000;
  const ch = hasAudio ? (audio.channels || 2) : 2;

  console.log(`[导出] mp4-muxer 开始封装：${width}x${height}@${fps}fps, 音频=${hasAudio ? sr + 'Hz ' + ch + 'ch' : '无'}`);

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: {
      codec: 'avc',
      width: width,
      height: height
    },
    audio: hasAudio ? {
      codec: 'aac',
      numberOfChannels: ch,
      sampleRate: sr
    } : undefined,
    fastStart: 'in-memory'
  });

  // 视频帧：逐个包装成 EncodedVideoChunk 喂给 muxer
  const frameDurationUs = Math.round(1_000_000 / fps);
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    const timestamp = i * frameDurationUs;
    const chunk = new EncodedVideoChunk({
      type: sample.isSync ? 'key' : 'delta',
      timestamp: timestamp,
      duration: frameDurationUs,
      data: sample.data
    });
    // meta 只在第一帧传（avcC description）
    const meta = i === 0 ? {
      decoderConfig: {
        codec: 'avc1.4d4028',
        description: new Uint8Array(description)
      }
    } : undefined;
    muxer.addVideoChunk(chunk, meta);
  }

  // 音频：逐个包装成 EncodedAudioChunk 喂给 muxer（AAC 原样透传）
  if (hasAudio) {
    let audioTimestampUs = 0;
    for (const sample of audio.samples) {
      const chunk = new EncodedAudioChunk({
        type: 'key',
        timestamp: audioTimestampUs,
        duration: Math.round(sample.duration),
        data: sample.data
      });
      muxer.addAudioChunk(chunk);
      audioTimestampUs += Math.round(sample.duration);
    }
    console.log(`[导出] 音频已写入 muxer：${audio.samples.length} samples, 总时长 ${(audioTimestampUs / 1e6).toFixed(2)}s`);
  }

  muxer.finalize();
  const { buffer } = muxer.target;
  console.log(`[导出] mp4-muxer 封装完成，大小 ${(buffer.byteLength / 1048576).toFixed(1)}MB`);
  return buffer;
}

function restoreAvcConfig(entry, description) {
  const bytes = new Uint8Array(description);
  const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const avcC = entry.avcC;
  if (!avcC) {
    throw new Error('视频轨缺少 avcC，播放器无法解码');
  }
  avcC.hdr_size = 0;
  avcC.size = copy.byteLength;
  avcC.parse(new MP4BoxStream(copy));
  if (!avcC.SPS?.length || !avcC.PPS?.length) {
    throw new Error('H.264 配置里没有 SPS/PPS');
  }
}

function mdatPayloadOffset(buffer) {
  const view = new DataView(buffer);
  let position = 0;
  while (position + 8 <= buffer.byteLength) {
    let size = view.getUint32(position);
    const type = String.fromCharCode(
      view.getUint8(position + 4),
      view.getUint8(position + 5),
      view.getUint8(position + 6),
      view.getUint8(position + 7)
    );
    let header = 8;
    if (size === 1) {
      header = 16;
      const high = view.getUint32(position + 8);
      const low = view.getUint32(position + 12);
      size = high * 2 ** 32 + low;
    }
    if (type === 'mdat') return position + header;
    if (size < header) break;
    position += size;
  }
  throw new Error('MP4 缺少 mdat');
}

function yieldThread() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
