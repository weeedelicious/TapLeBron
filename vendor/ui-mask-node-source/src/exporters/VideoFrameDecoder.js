import { createFile, DataStream } from 'mp4box';

/**
 * MP4 硬解码会话。
 * 压缩样本一次拆出来，VideoFrame 按时间滑窗解码，用完就关掉。
 * 几分钟的片子不会把全部原始帧堆在内存里。
 */
export class VideoFrameDecoder {
  constructor() {
    this.supported = typeof VideoDecoder !== 'undefined';
  }

  /**
   * @param {File|Blob} file
   * @returns {Promise<HardwareDecodeSession>}
   */
  async open(file, acceleration = 'prefer-hardware') {
    if (!this.supported) {
      throw new Error('浏览器不支持VideoDecoder');
    }
    console.log('[导出] 开始读取并拆封装');
    const buffer = await file.arrayBuffer();
    buffer.fileStart = 0;
    const demuxed = await demuxVideo(buffer);
    if (!demuxed.description) {
      throw new Error('缺少解码配置，无法硬解这条视频');
    }
    console.log(`[导出] 拆出 ${demuxed.samples.length} 个样本，编码 ${demuxed.codec}`);
    const session = new HardwareDecodeSession(demuxed);
    // 顺带提取音频轨（透传混流，保证导出带声音）
    try {
      session.audio = await demuxAudio(buffer);
      if (session.audio) {
        console.log(`[导出] 音频轨：${session.audio.samples.length} 样本，${session.audio.codec}`);
      } else {
        console.log('[导出] 源文件无音频轨');
      }
    } catch (err) {
      console.warn('[导出] 音频提取失败（继续视频导出）:', err.message);
      session.audio = null;
    }
    await session.start(acceleration);
    return session;
  }
}

export class HardwareDecodeSession {
  constructor(demuxed) {
    this.samples = demuxed.samples;
    this.codec = demuxed.codec;
    this.description = demuxed.description;
    this.width = demuxed.width;
    this.height = demuxed.height;
    this.frames = [];
    this.fed = 0;
    this.flushed = false;
    this.decodeError = null;
    this.waiters = [];
    this.decoder = null;
  }

  async start(acceleration = 'prefer-hardware') {
    const decoder = new VideoDecoder({
      output: (frame) => {
        this.frames.push(frame);
        this.wake();
      },
      error: (error) => {
        this.decodeError = error;
        this.wake();
      }
    });
    this.decoder = decoder;

    const config = await supportedDecoderConfig({
      codec: this.codec,
      codedWidth: this.width,
      codedHeight: this.height,
      description: this.description,
      hardwareAcceleration: acceleration
    });
    this.acceleration = config.hardwareAcceleration || acceleration;
    console.log(`[导出] 解码器使用 ${this.acceleration}`);
    decoder.configure(config);
  }

  /**
   * 取「这个时间点画面上应该显示的那一帧」。帧仍由会话持有，调用方不要 close。
   * @param {number} timeSec
   * @returns {Promise<VideoFrame>}
   */
  async frameAtTime(timeSec) {
    await this.ensure(timeSec);
    const frame = this.frameCovering(timeSec);
    if (!frame) {
      // 尾部帧因 flush 挂起没吐出来时，降级用最后一个有效帧（重复最后一帧），
      // 而不是抛错让整个导出失败。
      const lastGood = this.frames.reduceRight((acc, f) => acc || f, null);
      if (lastGood) return lastGood;
      throw new Error('解码结束时仍然缺少画面');
    }
    return frame;
  }

  /**
   * 关掉明显早于当前时间的帧，把显存让给后面的画面。
   * @param {number} timeSec
   */
  releaseBefore(timeSec) {
    const limit = timeSec - 1.5 / 24;
    for (let i = 0; i < this.frames.length; i++) {
      const frame = this.frames[i];
      if (!frame) continue;
      if (frame.timestamp / 1_000_000 >= limit) break;
      frame.close();
      this.frames[i] = null;
    }
  }

  close() {
    for (const frame of this.frames) frame?.close();
    this.frames = [];
    if (this.decoder && this.decoder.state !== 'closed') {
      try {
        this.decoder.close();
      } catch (err) {
        // 解码器已经因为出错关掉时，再 close 会抛
      }
    }
  }

  async ensure(timeSec) {
    const started = performance.now();
    while (true) {
      if (this.decodeError) {
        throw new Error(`解码失败: ${this.decodeError.message}`);
      }
      if (performance.now() - started > 20000) {
        throw new Error('解码超时，这一帧超过 20 秒没有出来');
      }
      const last = this.frames[this.frames.length - 1];
      if (last && last.timestamp / 1_000_000 >= timeSec - 0.0004) return;
      if (this.flushed) return;

      let fedNow = 0;
      while (fedNow < 4 && this.fed < this.samples.length && this.decoder.decodeQueueSize < 8) {
        const sample = this.samples[this.fed++];
        this.decoder.decode(new EncodedVideoChunk({
          type: sample.isSync ? 'key' : 'delta',
          timestamp: sample.timestamp,
          duration: sample.duration,
          data: sample.data
        }));
        fedNow += 1;
        if (this.fed % 120 === 0) {
          console.log(`[导出] 硬解 ${this.fed}/${this.samples.length}`);
        }
      }

      if (this.fed >= this.samples.length && this.decoder.decodeQueueSize === 0 && !this.flushed) {
        console.log(`[导出] 解码器收尾 flush，队列剩余 ${this.decoder.decodeQueueSize}`);
        // Chrome 硬件解码器在 4K 上 flush() 偶发挂起（W3C/Chromium 已知问题）。
        // 此时 decodeQueueSize===0，说明所有已喂样本都已处理，flush 只是冲尾部缓冲；
        // 挂起不能让整个导出失败——超时后直接标记 flushed，不 reset（reset 会把
        // 解码器里还没吐出来的尾部帧也清掉，导致 frameAtTime 找不到画面）。
        try {
          await withTimeout(this.decoder.flush(), 15000, 'flush 挂起（硬件解码器已知问题，降级继续）');
        } catch (flushErr) {
          console.warn('[导出] ' + flushErr.message + '，跳过 flush 继续（尾部帧可能重复最后一帧）');
        }
        this.flushed = true;
        continue;
      }

      if (fedNow === 0) {
        await withTimeout(this.waitForOutput(), 30000, '解码器没有输出画面，准备改用其他解码方式');
      } else {
        await yieldThread();
      }
    }
  }

  frameCovering(timeSec) {
    let chosen = null;
    for (const frame of this.frames) {
      if (!frame) continue;
      if (frame.timestamp / 1_000_000 <= timeSec + 0.0008) chosen = frame;
      else break;
    }
    if (chosen) return chosen;
    return this.frames.find(Boolean) || null;
  }

  waitForOutput() {
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  wake() {
    const pending = this.waiters;
    this.waiters = [];
    pending.forEach((resolve) => resolve());
  }
}

async function supportedDecoderConfig(preferred) {
  const accelerations = [
    preferred.hardwareAcceleration,
    'prefer-hardware',
    'no-preference',
    'prefer-software'
  ].filter((item, index, list) => item && list.indexOf(item) === index);
  let lastError = null;

  for (const hardwareAcceleration of accelerations) {
    const description = new Uint8Array(preferred.description).slice().buffer;
    const trial = { ...preferred, hardwareAcceleration, description };
    try {
      const support = await VideoDecoder.isConfigSupported(trial);
      if (!support.supported) continue;
      return {
        ...(support.config || trial),
        description: new Uint8Array(description).slice().buffer
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(lastError?.message || `当前浏览器不能解码 ${preferred.codec}`);
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

function yieldThread() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function stampSamples(samples) {
  let maxCts = 0;
  let maxDts = 0;
  for (const sample of samples) {
    if (sample.cts > maxCts) maxCts = sample.cts;
    if (sample.dts > maxDts) maxDts = sample.dts;
  }
  const useDts = maxCts <= 0 && maxDts > 0;
  if (useDts) console.log('[导出] 显示时间戳无效，改用解码时间戳');
  for (const sample of samples) {
    const tick = useDts ? sample.dts : sample.cts;
    sample.timestamp = Math.round((tick * 1_000_000) / sample.scale);
    sample.duration = Math.max(1, Math.round((sample.durationTicks * 1_000_000) / sample.scale));
  }
}

export function demuxVideo(buffer) {
  return new Promise((resolve, reject) => {
    const mp4 = createFile();
    const samples = [];
    let meta = null;

    mp4.onReady = (info) => {
      const track = info.videoTracks && info.videoTracks[0];
      if (!track) {
        reject(new Error('文件里没有视频轨'));
        return;
      }
      const trak = mp4.getTrackById(track.id);
      const entry = trak.mdia.minf.stbl.stsd.entries[0];
      const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
      meta = {
        track,
        description: box ? serializeBoxPayload(box) : null
      };
      mp4.setExtractionOptions(track.id, null, { nbSamples: 240 });
      mp4.start();
    };

    mp4.onSamples = (_id, _user, list) => {
      const timescale = meta?.track.timescale || list[0]?.timescale || 1;
      for (const sample of list) {
        const scale = sample.timescale || timescale;
        const cts = Number.isFinite(sample.cts) ? sample.cts : 0;
        const dts = Number.isFinite(sample.dts) ? sample.dts : cts;
        const raw = sample.data instanceof Uint8Array ? sample.data : new Uint8Array(sample.data);
        const data = new Uint8Array(raw.byteLength);
        data.set(raw);
        samples.push({
          data,
          isSync: Boolean(sample.is_sync),
          cts,
          dts,
          scale,
          durationTicks: sample.duration || Math.round(scale / 30)
        });
      }
    };

    try {
      mp4.appendBuffer(buffer);
      mp4.flush();
    } catch (error) {
      reject(error);
      return;
    }

    if (!meta || samples.length === 0) {
      reject(new Error('没能从 MP4 里抽出视频帧'));
      return;
    }
    stampSamples(samples);

    resolve({
      samples,
      codec: meta.track.codec,
      description: meta.description,
      width: Math.round(meta.track.video?.width || meta.track.track_width),
      height: Math.round(meta.track.video?.height || meta.track.track_height)
    });
  });
}

function serializeBoxPayload(box) {
  const stream = new DataStream();
  stream.endianness = DataStream.BIG_ENDIAN;
  box.write(stream);
  const bytes = new Uint8Array(stream.buffer);
  const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  const header = size === 1 ? 16 : 8;
  return bytes.slice(header).buffer;
}

/**
 * 从 MP4/MOV 里提取音频轨（透传混流用，不做解码）。
 * 无音频轨返回 null；否则返回 { samples, codec, timescale, channels, samplerate, esds }。
 * @param {ArrayBuffer} buffer 已 fileStart 标记的 MP4 buffer
 * @returns {Promise<object|null>}
 */
/**
 * 轻量音轨探测：只解析 moov 判断源视频有没有音轨、采样率/声道是多少。
 * 不做样本提取，大文件也很快（ms 级）。返回 null = 源视频无音轨。
 */
export function probeAudioTrack(buffer, onVideoTiming = null) {
  return new Promise((resolve) => {
    const mp4 = createFile();
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    mp4.onReady = (info) => {
      // Read source sample timing for mask-editor stepping. The editable node
      // FPS parameter is not evidence of the video's actual frame interval.
      const video = info.videoTracks?.[0];
      const table = video && mp4.getTrackById(video.id)?.mdia?.minf?.stbl?.stts;
      const deltas = table?.sample_deltas;
      const fps = deltas?.length && deltas[0] > 0 && deltas.every(delta => delta === deltas[0])
        ? video.timescale / deltas[0] : null;
      onVideoTiming?.(Number.isFinite(fps) && fps >= 1 && fps <= 240 ? fps : null);
      const t = info.audioTracks && info.audioTracks[0];
      if (!t) { finish(null); return; }
      const trak = mp4.getTrackById(t.id);
      const entry = trak?.mdia?.minf?.stbl?.stsd?.entries?.[0];
      finish({
        hasAudio: true,
        codec: t.codec || 'mp4a.40.2',
        channels: t.audio?.channel_count || entry?.channel_count || 2,
        samplerate: t.audio?.sample_rate || (entry?.samplerate ? entry.samplerate >> 16 : 48000)
      });
    };
    try {
      // mp4box 要求 buffer 带 fileStart 属性（指示该 buffer 在文件中的起始偏移），
      // 缺失时可能无法正确触发 onReady，导致「有音轨却被判定为无音轨」。
      try { buffer.fileStart = 0; } catch (e) { /* 只读 buffer 则忽略 */ }
      mp4.appendBuffer(buffer);
      mp4.flush();
    } catch (e) {
      finish(null);
    }
    // 兜底：某些文件 onReady 未触发时不要挂起（大文件解析可能需要更长时间）
    setTimeout(() => finish(null), 5000);
  });
}

export function demuxAudio(buffer) {
  return new Promise((resolve, reject) => {
    const mp4 = createFile();
    const samples = [];
    let meta = null;
    let esdsBytes = null;
    let esdsBoxInstance = null;

    mp4.onReady = (info) => {
      const track = info.audioTracks && info.audioTracks[0];
      if (!track) {
        resolve(null);
        return;
      }
      const trak = mp4.getTrackById(track.id);
      const entry = trak?.mdia?.minf?.stbl?.stsd?.entries?.[0];
      // 音频解码配置（ESDS，含采样率/声道），透传到输出轨保证播放器正确解出
      if (entry) {
        const esds = entry.esds;
        if (esds) {
          esdsBoxInstance = esds; // 实例本身也保留（带 write 原型，供输出轨 addBox 复用）
          try { esdsBytes = serializeBoxPayload(esds); } catch (e) { esdsBytes = null; }
        }
      }
      meta = { track };
      mp4.setExtractionOptions(track.id, null, { nbSamples: 240 });
      mp4.start();
    };

    mp4.onSamples = (_id, _user, list) => {
      const timescale = meta?.track.timescale || list[0]?.timescale || 48000;
      for (const sample of list) {
        const scale = sample.timescale || timescale;
        const cts = Number.isFinite(sample.cts) ? sample.cts : 0;
        const dts = Number.isFinite(sample.dts) ? sample.dts : cts;
        const raw = sample.data instanceof Uint8Array ? sample.data : new Uint8Array(sample.data);
        const data = new Uint8Array(raw.byteLength);
        data.set(raw);
        samples.push({
          data,
          isSync: Boolean(sample.is_sync),
          cts,
          dts,
          scale,
          durationTicks: sample.duration || Math.round(scale / 48000)
        });
      }
    };

    try {
      mp4.appendBuffer(buffer);
      mp4.flush();
    } catch (error) {
      reject(error);
      return;
    }

    if (!meta || samples.length === 0) {
      resolve(null);
      return;
    }

    // 时间戳转微秒（与视频 stampSamples 同规则）
    let maxCts = 0;
    let maxDts = 0;
    for (const s of samples) {
      if (s.cts > maxCts) maxCts = s.cts;
      if (s.dts > maxDts) maxDts = s.dts;
    }
    const useDts = maxCts <= 0 && maxDts > 0;
    for (const s of samples) {
      const tick = useDts ? s.dts : s.cts;
      s.timestamp = Math.round((tick * 1_000_000) / s.scale);
      s.duration = Math.max(1, Math.round((s.durationTicks * 1_000_000) / s.scale));
    }

    resolve({
      samples,
      codec: meta.track.codec || 'mp4a.40.2',
      timescale: meta.track.timescale || 48000,
      channels: meta.track.audio?.channel_count || 2,
      samplerate: meta.track.audio?.sample_rate || 48000,
      esds: esdsBytes,
      esdsBox: esdsBoxInstance
    });
  });
}
