/**
 * 纹理清晰化的本地保护融合链。
 *
 * 这是「只生成一次候选图仍然能保住原图」的关键：模型返回一整张候选图之后，接缝、色漂、
 * 蒙版外的擅自改动全靠这一层挡住。它不调任何生图 API，所以不产生第二次生图开销。
 *
 * 这个文件里全是纯函数 + 一个编排入口，输入输出都是 TypedArray 和宽高，不碰 sharp、不碰
 * 文件系统 —— 图像解码交给调用方，这样整条链能被 vitest 直接覆盖。
 *
 * 三个关键取舍，写在这里免得以后有人"顺手优化"掉：
 *
 * 1. 配准只估计整体平移，不做仿射/透视矫正。模型被明确要求不许改构图；真的改了，正确的
 *    反应是让质量门禁失败并把配准误差报出来，而不是把候选图掰回来 —— 掰回来等于我们自己
 *    动了几何，反而破坏"构图与原图一致"这条验收项。
 *
 * 2. 融合按低频/高频两段分：低频（整体明暗、肤色、光照关系）取原图，高频（毛孔、发丝、
 *    织物纹理）取候选图。这正是这个功能想要的东西 —— 要细节，不要模型顺手改掉的光和色。
 *    直接按蒙版做 alpha 混合会把候选图的低频一起带进来，那才是塑料感和色偏的来源。
 *
 * 3. 没有 opencv，高斯模糊用可分离盒式模糊跑三遍近似（O(n)，误差在这个用途上无关紧要）。
 *
 * 蒙版外像素等于原图这件事既靠构造保证（权重为 0），也在诊断里真数一遍。两者不一致就是
 * 这个文件有 bug，宁可让门禁失败也不要静悄悄放过去。
 */

'use strict';

const CHANNELS = 3;

/** 逐像素亮度。Rec.709 权重；只用于配准，不参与输出。 */
function luminance(rgb, width, height) {
  const out = new Float32Array(width * height);
  for (let i = 0, p = 0; i < out.length; i += 1, p += CHANNELS) {
    out[i] = 0.2126 * rgb[p] + 0.7152 * rgb[p + 1] + 0.0722 * rgb[p + 2];
  }
  return out;
}

/**
 * 整数倍盒式降采样。配准在小图上做：2K 上逐像素搜索平移太慢，而平移量本身是低频信息，
 * 降采样不会丢。
 */
function downscale(data, width, height, factor) {
  const f = Math.max(1, Math.floor(factor));
  if (f === 1) return { data, width, height };
  const outWidth = Math.max(1, Math.floor(width / f));
  const outHeight = Math.max(1, Math.floor(height / f));
  const out = new Float32Array(outWidth * outHeight);
  for (let y = 0; y < outHeight; y += 1) {
    for (let x = 0; x < outWidth; x += 1) {
      let sum = 0;
      let count = 0;
      for (let dy = 0; dy < f; dy += 1) {
        const sy = y * f + dy;
        if (sy >= height) break;
        for (let dx = 0; dx < f; dx += 1) {
          const sx = x * f + dx;
          if (sx >= width) break;
          sum += data[sy * width + sx];
          count += 1;
        }
      }
      out[y * outWidth + x] = count ? sum / count : 0;
    }
  }
  return { data: out, width: outWidth, height: outHeight };
}

/**
 * 在降采样亮度图上搜索最佳整体平移，返回原图尺度下的偏移与归一化误差。
 *
 * 误差是重叠区的平均绝对差除以 255，落在 0..1。它同时被质量门禁当作"候选图和原图差得
 * 有多远"的粗指标 —— 平移对齐之后仍然很大，说明模型动了构图或换了人。
 */
function estimateTranslation(sourceLum, candidateLum, width, height, options = {}) {
  const factor = Math.max(1, Math.floor(options.downscale || 4));
  const a = downscale(sourceLum, width, height, factor);
  const b = downscale(candidateLum, width, height, factor);
  const maxShift = Math.max(0, Math.floor(options.maxShift ?? 12));

  let bestDx = 0;
  let bestDy = 0;
  let bestError = Number.POSITIVE_INFINITY;

  for (let dy = -maxShift; dy <= maxShift; dy += 1) {
    for (let dx = -maxShift; dx <= maxShift; dx += 1) {
      let sum = 0;
      let count = 0;
      const yStart = Math.max(0, -dy);
      const yEnd = Math.min(a.height, a.height - dy);
      const xStart = Math.max(0, -dx);
      const xEnd = Math.min(a.width, a.width - dx);
      for (let y = yStart; y < yEnd; y += 1) {
        const aRow = y * a.width;
        const bRow = (y + dy) * b.width;
        for (let x = xStart; x < xEnd; x += 1) {
          sum += Math.abs(a.data[aRow + x] - b.data[bRow + x + dx]);
          count += 1;
        }
      }
      if (!count) continue;
      const error = sum / count;
      // 同样误差时偏向更小的位移：模型没动构图是常态，别被噪声推出一个假偏移
      const better = error < bestError - 1e-6
        || (Math.abs(error - bestError) <= 1e-6
          && Math.abs(dx) + Math.abs(dy) < Math.abs(bestDx) + Math.abs(bestDy));
      if (better) {
        bestError = error;
        bestDx = dx;
        bestDy = dy;
      }
    }
  }

  return {
    dx: bestDx * factor,
    dy: bestDy * factor,
    error: Number.isFinite(bestError) ? bestError / 255 : 1,
    downscale: factor,
  };
}

/**
 * 由语义类别图算融合支持区。
 * lookup 是 256 长的「原始类别 id → 内部类别 id」查表，supportFlags 是「内部类别 id →
 * 是否计入支持区」。两者都由 src/shared/texture-clarity-semantics.json 派生，绝不在这里
 * 反解颜色。
 */
function buildSupportMask(classMap, lookup, supportFlags) {
  const out = new Uint8Array(classMap.length);
  for (let i = 0; i < classMap.length; i += 1) {
    const internal = lookup[classMap[i]] || 0;
    out[i] = supportFlags[internal] ? 255 : 0;
  }
  return out;
}

/** 方形结构元的膨胀。语义边界通常比真实边界略紧，往外放一点再羽化，接缝才落在平坦区。 */
function dilateMask(mask, width, height, radius) {
  const r = Math.max(0, Math.floor(radius));
  if (r === 0) return mask.slice();
  // 可分离：先横向再纵向，等价于方形结构元，O(n·r) 而不是 O(n·r²)
  const tmp = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      let value = 0;
      const from = Math.max(0, x - r);
      const to = Math.min(width - 1, x + r);
      for (let k = from; k <= to; k += 1) {
        if (mask[row + k]) { value = 255; break; }
      }
      tmp[row + x] = value;
    }
  }
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    const from = Math.max(0, y - r);
    const to = Math.min(height - 1, y + r);
    for (let x = 0; x < width; x += 1) {
      let value = 0;
      for (let k = from; k <= to; k += 1) {
        if (tmp[k * width + x]) { value = 255; break; }
      }
      out[y * width + x] = value;
    }
  }
  return out;
}

/** 可分离盒式模糊，跑 passes 遍近似高斯。就地不安全，返回新数组。 */
function boxBlur(data, width, height, radius, passes = 3) {
  const r = Math.max(0, Math.floor(radius));
  if (r === 0) return Float32Array.from(data);
  let current = Float32Array.from(data);
  const scratch = new Float32Array(data.length);
  for (let pass = 0; pass < Math.max(1, passes); pass += 1) {
    // 横向
    for (let y = 0; y < height; y += 1) {
      const row = y * width;
      let sum = 0;
      for (let x = -r; x <= r; x += 1) sum += current[row + Math.min(width - 1, Math.max(0, x))];
      for (let x = 0; x < width; x += 1) {
        scratch[row + x] = sum / (2 * r + 1);
        const outIndex = row + Math.min(width - 1, Math.max(0, x - r));
        const inIndex = row + Math.min(width - 1, Math.max(0, x + r + 1));
        sum += current[inIndex] - current[outIndex];
      }
    }
    // 纵向
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      for (let y = -r; y <= r; y += 1) sum += scratch[Math.min(height - 1, Math.max(0, y)) * width + x];
      for (let y = 0; y < height; y += 1) {
        current[y * width + x] = sum / (2 * r + 1);
        const outIndex = Math.min(height - 1, Math.max(0, y - r)) * width + x;
        const inIndex = Math.min(height - 1, Math.max(0, y + r + 1)) * width + x;
        sum += scratch[inIndex] - scratch[outIndex];
      }
    }
  }
  return current;
}

/** 按整体平移把候选图搬到原图坐标系。落到画外的位置用原图填 —— 那里本来就不该改。 */
function shiftRgb(candidate, source, width, height, dx, dy) {
  if (dx === 0 && dy === 0) return Uint8Array.from(candidate);
  const out = new Uint8Array(candidate.length);
  for (let y = 0; y < height; y += 1) {
    const sy = y + dy;
    for (let x = 0; x < width; x += 1) {
      const sx = x + dx;
      const target = (y * width + x) * CHANNELS;
      if (sy < 0 || sy >= height || sx < 0 || sx >= width) {
        out[target] = source[target];
        out[target + 1] = source[target + 1];
        out[target + 2] = source[target + 2];
        continue;
      }
      const from = (sy * width + sx) * CHANNELS;
      out[target] = candidate[from];
      out[target + 1] = candidate[from + 1];
      out[target + 2] = candidate[from + 2];
    }
  }
  return out;
}

/** 提一个通道出来做频域运算。 */
function channelOf(rgb, width, height, channel) {
  const out = new Float32Array(width * height);
  for (let i = 0, p = channel; i < out.length; i += 1, p += CHANNELS) out[i] = rgb[p];
  return out;
}

function clamp255(value) {
  return value < 0 ? 0 : value > 255 ? 255 : value;
}

/**
 * 两段融合 + 低频色漂校正，一次遍历做完。
 *
 *   低频取原图、高频取候选图，按羽化权重 w 混合：
 *     out = source + w * (candidateHigh - sourceHigh)
 *   其中 high = 原值 - 低频。展开就是 out = source + w * ((C - Clow) - (S - Slow))。
 *
 * 这个式子天然满足两件事：
 *   - w = 0 处 out 严格等于 source（蒙版外不动，不依赖后面再补一次覆盖）；
 *   - 候选图整体偏亮/偏色只影响它自己的低频 Clow，被减掉了，所以色漂不会带进来 ——
 *     这就是"低频色漂校正"，不需要再单独算一次比值。
 */
function blendBands(source, candidate, weight, width, height, options = {}) {
  const radius = Math.max(1, Math.floor(options.lowFrequencyRadius || Math.round(Math.max(width, height) / 64) || 8));
  const passes = Math.max(1, Math.floor(options.blurPasses || 3));
  const gain = Number.isFinite(options.detailGain) ? options.detailGain : 1;
  const out = new Uint8Array(source.length);

  for (let channel = 0; channel < CHANNELS; channel += 1) {
    const s = channelOf(source, width, height, channel);
    const c = channelOf(candidate, width, height, channel);
    const sLow = boxBlur(s, width, height, radius, passes);
    const cLow = boxBlur(c, width, height, radius, passes);
    for (let i = 0; i < s.length; i += 1) {
      const w = weight[i];
      if (w <= 0) {
        out[i * CHANNELS + channel] = source[i * CHANNELS + channel];
        continue;
      }
      const detail = (c[i] - cLow[i]) - (s[i] - sLow[i]);
      out[i * CHANNELS + channel] = clamp255(Math.round(s[i] + w * gain * detail));
    }
  }
  return out;
}

/** 0..255 的蒙版转 0..1 权重。 */
function maskToWeight(mask) {
  const out = new Float32Array(mask.length);
  for (let i = 0; i < mask.length; i += 1) out[i] = mask[i] / 255;
  return out;
}

/**
 * 数一遍支持区外有多少像素跟原图不一样。按构造应当恒为 0；不为 0 就是这个文件有 bug。
 * threshold 给 0 是刻意的 —— 这里要的是"逐字节相等"，不是"看起来差不多"。
 */
function countOutsideChanges(output, source, weight, threshold = 0) {
  let changed = 0;
  for (let i = 0; i < weight.length; i += 1) {
    if (weight[i] > 0) continue;
    const p = i * CHANNELS;
    if (Math.abs(output[p] - source[p]) > threshold
      || Math.abs(output[p + 1] - source[p + 1]) > threshold
      || Math.abs(output[p + 2] - source[p + 2]) > threshold) {
      changed += 1;
    }
  }
  return changed;
}

/**
 * 接缝色差：在羽化带（0 < w < 1）里量输出与原图的平均通道差。
 * 这一条比"蒙版外有没有变"更接近人眼看到的接缝 —— 带子里差得越多，越可能看出亮度带或颜色边。
 */
function seamColorDelta(output, source, weight) {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < weight.length; i += 1) {
    const w = weight[i];
    if (w <= 0 || w >= 1) continue;
    const p = i * CHANNELS;
    sum += (Math.abs(output[p] - source[p])
      + Math.abs(output[p + 1] - source[p + 1])
      + Math.abs(output[p + 2] - source[p + 2])) / 3;
    count += 1;
  }
  return count ? sum / count : 0;
}

/** 支持区覆盖率，用来识别"语义分区基本没切出人"这种情况。 */
function maskCoverage(weight) {
  let sum = 0;
  for (let i = 0; i < weight.length; i += 1) sum += weight[i];
  return weight.length ? sum / weight.length : 0;
}

const DEFAULT_GATES = {
  // 平移超过这个像素数就判失败：模型动了构图，不该靠我们把它掰回来
  maxRegistrationShift: 24,
  // 对齐后仍然差这么多，基本是换了人或重构了背景
  maxRegistrationError: 0.18,
  // 支持区太小说明语义分区没切出人，融合等于没做
  minMaskCoverage: 0.01,
  // 接缝带里的平均通道差上限
  maxSeamColorDelta: 24,
};

/**
 * 融合链入口。
 *
 * 入参都是已经解码好的等尺寸缓冲：source/candidate 是 RGB8（3 通道紧密排列），
 * classMap 是单通道的原始语义类别 id。调用方负责尺寸规范化与解码。
 */
function fuseTextureClarity(input) {
  const {
    source,
    candidate,
    classMap,
    width,
    height,
    lookup,
    supportFlags,
    options = {},
  } = input;

  const pixels = width * height;
  if (!width || !height) throw new Error('宽高必须为正');
  if (source.length !== pixels * CHANNELS) throw new Error('原图缓冲尺寸不符');
  if (candidate.length !== pixels * CHANNELS) throw new Error('候选图缓冲尺寸不符');
  if (classMap.length !== pixels) throw new Error('语义类别图尺寸不符');

  const gates = { ...DEFAULT_GATES, ...(options.gates || {}) };

  const sourceLum = luminance(source, width, height);
  const candidateLum = luminance(candidate, width, height);
  const registration = estimateTranslation(sourceLum, candidateLum, width, height, {
    downscale: options.registrationDownscale || 4,
    maxShift: options.registrationMaxShift ?? 12,
  });

  const aligned = shiftRgb(candidate, source, width, height, registration.dx, registration.dy);

  const rawMask = buildSupportMask(classMap, lookup, supportFlags);
  const dilateRadius = Number.isFinite(options.dilateRadius)
    ? options.dilateRadius
    : Math.max(2, Math.round(Math.max(width, height) / 400));
  const featherRadius = Number.isFinite(options.featherRadius)
    ? options.featherRadius
    : Math.max(2, Math.round(Math.max(width, height) / 320));
  const dilated = dilateMask(rawMask, width, height, dilateRadius);
  const feathered = boxBlur(Float32Array.from(dilated), width, height, featherRadius, 2);
  const weight = new Float32Array(pixels);
  for (let i = 0; i < pixels; i += 1) {
    const value = feathered[i] / 255;
    weight[i] = value <= 0 ? 0 : value >= 1 ? 1 : value;
  }

  const output = blendBands(source, aligned, weight, width, height, options);

  const outsideChangedPixels = countOutsideChanges(output, source, weight);
  const diagnostics = {
    width,
    height,
    registrationDx: registration.dx,
    registrationDy: registration.dy,
    registrationError: Number(registration.error.toFixed(5)),
    registrationDownscale: registration.downscale,
    dilateRadius,
    featherRadius,
    lowFrequencyRadius: Math.max(1, Math.floor(options.lowFrequencyRadius || Math.round(Math.max(width, height) / 64) || 8)),
    detailGain: Number.isFinite(options.detailGain) ? options.detailGain : 1,
    maskCoverage: Number(maskCoverage(weight).toFixed(5)),
    rawMaskCoverage: Number((rawMask.reduce((acc, v) => acc + (v ? 1 : 0), 0) / pixels).toFixed(5)),
    outsideChangedPixels,
    seamColorDelta: Number(seamColorDelta(output, source, weight).toFixed(3)),
    fusionPolicy: 'smart-blend-multiscale-v1',
  };

  const failures = [];
  if (Math.abs(registration.dx) > gates.maxRegistrationShift
    || Math.abs(registration.dy) > gates.maxRegistrationShift) {
    failures.push({
      code: 'REGISTRATION_SHIFT',
      message: `候选图整体位移 ${registration.dx},${registration.dy} 像素，超过 ${gates.maxRegistrationShift}，构图被改动了`,
    });
  }
  if (registration.error > gates.maxRegistrationError) {
    failures.push({
      code: 'REGISTRATION_ERROR',
      message: `对齐后与原图的平均差 ${diagnostics.registrationError}，超过 ${gates.maxRegistrationError}`,
    });
  }
  if (diagnostics.maskCoverage < gates.minMaskCoverage) {
    failures.push({
      code: 'MASK_TOO_SMALL',
      message: `融合支持区只占 ${(diagnostics.maskCoverage * 100).toFixed(2)}%，语义分区没有切出人物`,
    });
  }
  if (diagnostics.seamColorDelta > gates.maxSeamColorDelta) {
    failures.push({
      code: 'SEAM_COLOR_DELTA',
      message: `接缝带平均通道差 ${diagnostics.seamColorDelta}，超过 ${gates.maxSeamColorDelta}`,
    });
  }
  if (outsideChangedPixels > 0) {
    // 走到这里说明融合本身写错了，不是模型的问题。必须失败，不能放过去。
    failures.push({
      code: 'OUTSIDE_MASK_CHANGED',
      message: `支持区外有 ${outsideChangedPixels} 个像素与原图不同，这是融合链的 bug`,
    });
  }

  return { output, weight, diagnostics, failures, passed: failures.length === 0 };
}

module.exports = {
  DEFAULT_GATES,
  blendBands,
  boxBlur,
  buildSupportMask,
  countOutsideChanges,
  dilateMask,
  downscale,
  estimateTranslation,
  fuseTextureClarity,
  luminance,
  maskCoverage,
  maskToWeight,
  seamColorDelta,
  shiftRgb,
};
