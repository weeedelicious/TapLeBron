/**
 * AI光流帧插值 - 基于 framegen (WebGPU)
 * 效果对标专业软件，重影极少
 * 
 * 需要：Chrome 113+ / Edge 113+ 支持 WebGPU
 * 不支持时自动降级到块匹配光流
 */
import { createRT } from 'framegen';

let rtInstance = null;
let gpuDevice = null;
let isSupported = null;
let weightsCache = null;

/**
 * 检查是否支持 WebGPU
 */
export async function checkAISupport() {
  if (isSupported !== null) return isSupported;
  
  if (!navigator.gpu) {
    isSupported = false;
    console.warn('[AI光流] 当前浏览器不支持 WebGPU，降级到块匹配模式');
    return false;
  }
  
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      isSupported = false;
      console.warn('[AI光流] 找不到 GPU 适配器，降级到块匹配模式');
      return false;
    }
    const requiredFeatures = adapter.features.has('shader-f16') ? ['shader-f16'] : [];
    try {
      gpuDevice = await adapter.requestDevice({ requiredFeatures });
    } catch (e) {
      gpuDevice = await adapter.requestDevice();
    }
    isSupported = true;
    console.log('[AI光流] WebGPU 支持正常');
    return true;
  } catch (e) {
    isSupported = false;
    console.warn('[AI光流] WebGPU 初始化失败：', e);
    return false;
  }
}

/**
 * 初始化 AI 光流运行时
 * @param {number} width 帧宽度（必须是16的倍数）
 * @param {number} height 帧高度（必须是16的倍数）
 */
export async function initAIFlow(width, height) {
  if (!await checkAISupport()) {
    throw new Error('WebGPU 不支持');
  }
  
  // 对齐到16的倍数
  const w = Math.ceil(width / 16) * 16;
  const h = Math.ceil(height / 16) * 16;
  
  if (rtInstance && rtInstance.w === w && rtInstance.h === h) {
    return rtInstance; // 已初始化过，直接复用
  }
  
  if (rtInstance) {
    rtInstance.destroy();
    rtInstance = null;
  }
  
  // 加载权重二进制（缓存，只加载一次）
  if (!weightsCache) {
    const [binRes, jsonRes] = await Promise.all([
      fetch('/models/rt_v7s.bin'),
      fetch('/models/rt_v7s.json'),
    ]);
    if (!binRes.ok || !jsonRes.ok) {
      throw new Error(`权重加载失败 bin=${binRes.status} json=${jsonRes.status}`);
    }
    const weightsBin = await binRes.arrayBuffer();
    const weightsManifest = await jsonRes.json();
    weightsCache = { weightsBin, weightsManifest };
  }
  
  // rt_v7s 是 t-factored 权重，必须贴图进、贴图出。缓冲区模式会直接报错。
  rtInstance = await createRT(gpuDevice, {
    w,
    h,
    weightsBin: weightsCache.weightsBin,
    weightsManifest: weightsCache.weightsManifest,
    textureInput: true,
    textureOutput: true,
    sparseRefine: true,
  });
  
  console.log(`[AI光流] 初始化完成 ${w}x${h}`);
  return rtInstance;
}

/**
 * 用 AI 光流生成中间帧
 * @param {ImageBitmap} prevImage 前帧
 * @param {ImageBitmap} nextImage 后帧
 * @param {number} t 时间比例（0~1）
 * @returns {HTMLCanvasElement} 中间帧
 */
function uploadFrameTexture(source, width, height) {
  let image = source;
  if (source.width !== width || source.height !== height) {
    const pad = document.createElement('canvas');
    pad.width = width;
    pad.height = height;
    pad.getContext('2d').drawImage(source, 0, 0);
    image = pad;
  }
  const texture = gpuDevice.createTexture({
    size: [width, height, 1],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING
      | GPUTextureUsage.COPY_DST
      | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  gpuDevice.queue.copyExternalImageToTexture(
    { source: image },
    { texture },
    [width, height],
  );
  return texture;
}

async function readTexture(texture, width, height) {
  const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
  const buffer = gpuDevice.createBuffer({
    size: bytesPerRow * height,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const encoder = gpuDevice.createCommandEncoder();
  encoder.copyTextureToBuffer(
    { texture },
    { buffer, bytesPerRow },
    { width, height },
  );
  gpuDevice.queue.submit([encoder.finish()]);
  await buffer.mapAsync(GPUMapMode.READ);
  const mapped = new Uint8Array(buffer.getMappedRange());
  const pixels = new Uint8ClampedArray(width * height * 4);
  if (bytesPerRow === width * 4) {
    pixels.set(mapped.subarray(0, pixels.length));
  } else {
    for (let y = 0; y < height; y++) {
      pixels.set(mapped.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
    }
  }
  buffer.unmap();
  buffer.destroy();
  return pixels;
}

export async function generateIntermediateFrameAI(prevImage, nextImage, t = 0.5) {
  const srcW = prevImage.width;
  const srcH = prevImage.height;
  const rt = await initAIFlow(srcW, srcH);
  const w = rt.w;
  const h = rt.h;

  const texA = uploadFrameTexture(prevImage, w, h);
  const texB = uploadFrameTexture(nextImage, w, h);
  const outTex = gpuDevice.createTexture({
    size: [w, h, 1],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
  });

  try {
    rt.prepPair(texA, texB);
    rt.runT(t, outTex);
    const pixels = await readTexture(outTex, w, h);

    // 纯AI输出（后处理方案失败，先回退）
    const resultCanvas = document.createElement('canvas');
    resultCanvas.width = srcW;
    resultCanvas.height = srcH;
    const ctx = resultCanvas.getContext('2d');
    if (srcW === w && srcH === h) {
      ctx.putImageData(new ImageData(pixels, w, h), 0, 0);
    } else {
      const full = document.createElement('canvas');
      full.width = w;
      full.height = h;
      full.getContext('2d').putImageData(new ImageData(pixels, w, h), 0, 0);
      ctx.drawImage(full, 0, 0, srcW, srcH);
    }
    return resultCanvas;
  } finally {
    texA.destroy();
    texB.destroy();
    outTex.destroy();
  }
}

/**
 * 自适应锐化：恢复边缘清晰度
 * 用卷积核做简单的锐化处理，SVP 专业做法
 * @param {CanvasRenderingContext2D} ctx 画布上下文
 * @param {number} w 宽度
 * @param {number} h 高度
 * @param {number} strength 锐化强度（0~1）
 */
function applySharpen(ctx, w, h, strength = 0.6) {
  const imageData = ctx.getImageData(0, 0, w, h);
  const data = imageData.data;
  const output = new Uint8ClampedArray(data.length);
  
  // 锐化卷积核
  const kernel = [
    0, -1, 0,
    -1, 4 + strength * 2, -1,
    0, -1, 0
  ];
  const kernelSum = kernel.reduce((a, b) => a + b, 0);
  
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let ky = -1; ky <= 1; ky++) {
          for (let kx = -1; kx <= 1; kx++) {
            const idx = ((y + ky) * w + (x + kx)) * 4 + c;
            sum += data[idx] * kernel[(ky + 1) * 3 + (kx + 1)];
          }
        }
        const outIdx = (y * w + x) * 4 + c;
        output[outIdx] = sum / kernelSum;
      }
      output[(y * w + x) * 4 + 3] = 255;
    }
  }
  
  // 边缘像素直接复制
  for (let x = 0; x < w; x++) {
    output[x * 4] = data[x * 4];
    output[x * 4 + 1] = data[x * 4 + 1];
    output[x * 4 + 2] = data[x * 4 + 2];
    output[x * 4 + 3] = 255;
    output[((h - 1) * w + x) * 4] = data[((h - 1) * w + x) * 4];
    output[((h - 1) * w + x) * 4 + 1] = data[((h - 1) * w + x) * 4 + 1];
    output[((h - 1) * w + x) * 4 + 2] = data[((h - 1) * w + x) * 4 + 2];
    output[((h - 1) * w + x) * 4 + 3] = 255;
  }
  for (let y = 0; y < h; y++) {
    output[y * w * 4] = data[y * w * 4];
    output[y * w * 4 + 1] = data[y * w * 4 + 1];
    output[y * w * 4 + 2] = data[y * w * 4 + 2];
    output[y * w * 4 + 3] = 255;
    output[(y * w + w - 1) * 4] = data[(y * w + w - 1) * 4];
    output[(y * w + w - 1) * 4 + 1] = data[(y * w + w - 1) * 4 + 1];
    output[(y * w + w - 1) * 4 + 2] = data[(y * w + w - 1) * 4 + 2];
    output[(y * w + w - 1) * 4 + 3] = 255;
  }
  
  ctx.putImageData(new ImageData(output, w, h), 0, 0);
}
