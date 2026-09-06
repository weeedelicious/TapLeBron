import type { AppearancePaletteColor, AppearanceTransferState } from './appearance-transfer-types'

type ChannelStats = {
  mean: [number, number, number]
  deviation: [number, number, number]
  luminance: number
  contrast: number
  warmBias: number
  oklabMean: [number, number, number]
  oklabDeviation: [number, number, number]
  luminancePercentiles: [number, number, number, number]
  keyLight: { x: number; y: number; confidence: number }
}

export type AppearancePreviewControls = {
  subjectMask?: ImageData | null
  depth?: ImageData | null
  normal?: ImageData | null
}

export type AppearanceReferenceProfile = {
  palette: AppearancePaletteColor[]
  stats: ChannelStats
  darkColor: [number, number, number]
  lightColor: [number, number, number]
}

const clampByte = (value: number) => Math.max(0, Math.min(255, Math.round(value)))
const clampUnit = (value: number) => Math.max(0, Math.min(1, value))
const clamp = (value: number, minimum: number, maximum: number) =>
  Math.max(minimum, Math.min(maximum, value))

function colorHex(red: number, green: number, blue: number) {
  return `#${[red, green, blue].map((value) => clampByte(value).toString(16).padStart(2, '0')).join('')}`
}

function luminance(red: number, green: number, blue: number) {
  return (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255
}

function srgbToLinear(value: number) {
  const unit = clampUnit(value / 255)
  return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4
}

function linearToSrgb(value: number) {
  const unit = value <= 0.0031308 ? value * 12.92 : 1.055 * Math.max(0, value) ** (1 / 2.4) - 0.055
  return unit * 255
}

function rgbToOklab(red: number, green: number, blue: number): [number, number, number] {
  const r = srgbToLinear(red)
  const g = srgbToLinear(green)
  const b = srgbToLinear(blue)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

function oklabToRgb(lightness: number, a: number, b: number): [number, number, number] {
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ]
}

function gamutSafeOklab(lightness: number, a: number, b: number): [number, number, number] {
  let chromaScale = 1
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const rgb = oklabToRgb(lightness, a * chromaScale, b * chromaScale)
    if (rgb.every((channel) => channel >= 0 && channel <= 255)) return rgb
    chromaScale *= 0.82
  }
  return oklabToRgb(lightness, a * chromaScale, b * chromaScale)
}

export function analyzeAppearanceImage(image: ImageData, paletteSize = 6): AppearanceReferenceProfile {
  const bins = new Map<number, { count: number; red: number; green: number; blue: number }>()
  const values: Array<[number, number, number, number]> = []
  const oklabValues: Array<[number, number, number]> = []
  const stride = Math.max(1, Math.floor(Math.sqrt((image.width * image.height) / 24_000)))
  let count = 0
  let sumRed = 0
  let sumGreen = 0
  let sumBlue = 0
  let sumLum = 0
  const oklabSums = [0, 0, 0]

  for (let y = 0; y < image.height; y += stride) {
    for (let x = 0; x < image.width; x += stride) {
      const offset = (y * image.width + x) * 4
      const alpha = image.data[offset + 3] / 255
      if (alpha < 0.35) continue
      const red = image.data[offset]
      const green = image.data[offset + 1]
      const blue = image.data[offset + 2]
      const lum = luminance(red, green, blue)
      const oklab = rgbToOklab(red, green, blue)
      values.push([red, green, blue, lum])
      oklabValues.push(oklab)
      sumRed += red
      sumGreen += green
      sumBlue += blue
      sumLum += lum
      oklabSums[0] += oklab[0]
      oklabSums[1] += oklab[1]
      oklabSums[2] += oklab[2]
      count += 1
      const key = (red >> 4) * 256 + (green >> 4) * 16 + (blue >> 4)
      const bin = bins.get(key) ?? { count: 0, red: 0, green: 0, blue: 0 }
      bin.count += 1
      bin.red += red
      bin.green += green
      bin.blue += blue
      bins.set(key, bin)
    }
  }

  if (!count) {
    return {
      palette: [{ hex: '#808080', weight: 1 }],
      stats: {
        mean: [128, 128, 128],
        deviation: [1, 1, 1],
        luminance: 0.5,
        contrast: 0,
        warmBias: 0,
        oklabMean: [0.6, 0, 0],
        oklabDeviation: [0.01, 0.01, 0.01],
        luminancePercentiles: [0.1, 0.5, 0.9, 0.98],
        keyLight: { x: 0.5, y: 0.35, confidence: 0 },
      },
      darkColor: [32, 32, 32],
      lightColor: [224, 224, 224],
    }
  }

  const mean: [number, number, number] = [sumRed / count, sumGreen / count, sumBlue / count]
  const deviationSums = [0, 0, 0]
  const oklabMean: [number, number, number] = [
    oklabSums[0] / count,
    oklabSums[1] / count,
    oklabSums[2] / count,
  ]
  const oklabDeviationSums = [0, 0, 0]
  let luminanceDeviation = 0
  for (let index = 0; index < values.length; index += 1) {
    const [red, green, blue, lum] = values[index]
    const oklab = oklabValues[index]
    deviationSums[0] += (red - mean[0]) ** 2
    deviationSums[1] += (green - mean[1]) ** 2
    deviationSums[2] += (blue - mean[2]) ** 2
    oklabDeviationSums[0] += (oklab[0] - oklabMean[0]) ** 2
    oklabDeviationSums[1] += (oklab[1] - oklabMean[1]) ** 2
    oklabDeviationSums[2] += (oklab[2] - oklabMean[2]) ** 2
    luminanceDeviation += (lum - sumLum / count) ** 2
  }

  const sorted = values.slice().sort((left, right) => left[3] - right[3])
  const dark = sorted[Math.floor(sorted.length * 0.12)] ?? sorted[0]
  const light = sorted[Math.floor(sorted.length * 0.88)] ?? sorted[sorted.length - 1]
  const rankedBins = [...bins.values()]
    .sort((left, right) => right.count - left.count)
    .slice(0, Math.max(1, paletteSize))
  const paletteTotal = rankedBins.reduce((total, bin) => total + bin.count, 0)
  const luminanceAt = (quantile: number) =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * quantile)))]?.[3] ?? quantile
  const brightThreshold = luminanceAt(0.82)
  let brightWeight = 0
  let brightX = 0
  let brightY = 0
  for (let y = 0; y < image.height; y += stride) {
    for (let x = 0; x < image.width; x += stride) {
      const offset = (y * image.width + x) * 4
      if (image.data[offset + 3] < 90) continue
      const lum = luminance(image.data[offset], image.data[offset + 1], image.data[offset + 2])
      const weight = Math.max(0, lum - brightThreshold) ** 1.5
      brightWeight += weight
      brightX += (x / Math.max(1, image.width - 1)) * weight
      brightY += (y / Math.max(1, image.height - 1)) * weight
    }
  }

  return {
    palette: rankedBins.map((bin) => ({
      hex: colorHex(bin.red / bin.count, bin.green / bin.count, bin.blue / bin.count),
      weight: bin.count / paletteTotal,
    })),
    stats: {
      mean,
      deviation: [
        Math.max(1, Math.sqrt(deviationSums[0] / count)),
        Math.max(1, Math.sqrt(deviationSums[1] / count)),
        Math.max(1, Math.sqrt(deviationSums[2] / count)),
      ],
      luminance: sumLum / count,
      contrast: Math.sqrt(luminanceDeviation / count),
      warmBias: (mean[0] - mean[2]) / 255,
      oklabMean,
      oklabDeviation: [
        Math.max(0.005, Math.sqrt(oklabDeviationSums[0] / count)),
        Math.max(0.005, Math.sqrt(oklabDeviationSums[1] / count)),
        Math.max(0.005, Math.sqrt(oklabDeviationSums[2] / count)),
      ],
      luminancePercentiles: [luminanceAt(0.1), luminanceAt(0.5), luminanceAt(0.9), luminanceAt(0.98)],
      keyLight: {
        x: brightWeight > 0 ? brightX / brightWeight : 0.5,
        y: brightWeight > 0 ? brightY / brightWeight : 0.35,
        confidence: clampUnit(brightWeight / Math.max(1, count * 0.03)),
      },
    },
    darkColor: [dark[0], dark[1], dark[2]],
    lightColor: [light[0], light[1], light[2]],
  }
}

function skinProbability(red: number, green: number, blue: number) {
  const [lightness, a, b] = rgbToOklab(red, green, blue)
  const chroma = Math.hypot(a, b)
  const hue = Math.atan2(b, a)
  const hueScore = Math.exp(-(((hue - 0.72) / 0.62) ** 2))
  const lightnessScore = clampUnit(1 - Math.abs(lightness - 0.66) / 0.5)
  const chromaScore = clampUnit((chroma - 0.018) / 0.11) * clampUnit((0.24 - chroma) / 0.14)
  return clampUnit(hueScore * lightnessScore * chromaScore)
}

export function renderAppearancePreview(
  source: ImageData,
  sourceProfile: AppearanceReferenceProfile,
  referenceProfile: AppearanceReferenceProfile,
  state: AppearanceTransferState,
  controls: AppearancePreviewControls = {},
) {
  const output =
    typeof ImageData === 'undefined'
      ? ({
          data: new Uint8ClampedArray(source.data),
          width: source.width,
          height: source.height,
          colorSpace: 'srgb',
        } as ImageData)
      : new ImageData(new Uint8ClampedArray(source.data), source.width, source.height)
  if (state.previewMode !== 'color' || !state.colorEnabled) return output

  const colorMix = state.colorStrength / 100
  if (colorMix === 0) return output
  const luminanceMix = state.luminanceMatch / 100
  const saturationScale = 0.75 + state.saturation / 200
  const temperatureShift = ((state.temperature - 50) / 50) * 0.035
  const referenceLightnessScale = clamp(
    referenceProfile.stats.oklabDeviation[0] / sourceProfile.stats.oklabDeviation[0],
    0.72,
    1.28,
  )
  const referenceAChromaScale = clamp(
    referenceProfile.stats.oklabDeviation[1] / sourceProfile.stats.oklabDeviation[1],
    0.65,
    1.5,
  )
  const referenceBChromaScale = clamp(
    referenceProfile.stats.oklabDeviation[2] / sourceProfile.stats.oklabDeviation[2],
    0.65,
    1.5,
  )

  for (let offset = 0; offset < output.data.length; offset += 4) {
    const original = [source.data[offset], source.data[offset + 1], source.data[offset + 2]] as const
    const originalLab = rgbToOklab(...original)
    const subjectWeight =
      controls.subjectMask && controls.subjectMask.data.length === source.data.length
        ? controls.subjectMask.data[offset] / 255
        : 1
    const skinProtection = state.preserveSkin
      ? 1 - skinProbability(...original) * subjectWeight * 0.88
      : 1
    const highlightProtection = 1 - clamp((originalLab[0] - 0.72) / 0.25, 0, 1) * 0.58
    const localColorMix = colorMix * skinProtection * highlightProtection

    const [sourceP10, sourceP50, sourceP90, sourceP98] = sourceProfile.stats.luminancePercentiles
    const [referenceP10, referenceP50, referenceP90, referenceP98] = referenceProfile.stats.luminancePercentiles
    const sourceLum = clampUnit(luminance(...original))
    const percentileTarget = sourceLum <= sourceP50
      ? referenceP10 + ((sourceLum - sourceP10) / Math.max(0.01, sourceP50 - sourceP10)) * (referenceP50 - referenceP10)
      : sourceLum <= sourceP90
        ? referenceP50 + ((sourceLum - sourceP50) / Math.max(0.01, sourceP90 - sourceP50)) * (referenceP90 - referenceP50)
        : referenceP90 + ((sourceLum - sourceP90) / Math.max(0.01, sourceP98 - sourceP90)) * (referenceP98 - referenceP90)
    const targetLightness =
      referenceProfile.stats.oklabMean[0] +
      (originalLab[0] - sourceProfile.stats.oklabMean[0]) * referenceLightnessScale +
      (clampUnit(percentileTarget) - sourceLum) * 0.32
    const lightnessDelta = clamp(targetLightness - originalLab[0], -0.1, 0.1)
    const lightness =
      originalLab[0] + lightnessDelta * luminanceMix * localColorMix

    let targetA =
      referenceProfile.stats.oklabMean[1] +
      (originalLab[1] - sourceProfile.stats.oklabMean[1]) * referenceAChromaScale
    let targetB =
      referenceProfile.stats.oklabMean[2] +
      (originalLab[2] - sourceProfile.stats.oklabMean[2]) * referenceBChromaScale
    const chromaDeltaA = targetA - originalLab[1]
    const chromaDeltaB = targetB - originalLab[2]
    const chromaDelta = Math.hypot(chromaDeltaA, chromaDeltaB)
    if (chromaDelta > 0.12) {
      const scale = 0.12 / chromaDelta
      targetA = originalLab[1] + chromaDeltaA * scale
      targetB = originalLab[2] + chromaDeltaB * scale
    }
    let a = originalLab[1] + (targetA - originalLab[1]) * localColorMix
    let b = originalLab[2] + (targetB - originalLab[2]) * localColorMix
    a += temperatureShift * 0.22 * localColorMix
    b += temperatureShift * localColorMix
    const localSaturationScale = 1 + (saturationScale - 1) * localColorMix
    a *= localSaturationScale
    b *= localSaturationScale

    const [red, green, blue] = gamutSafeOklab(lightness, a, b)

    output.data[offset] = clampByte(red)
    output.data[offset + 1] = clampByte(green)
    output.data[offset + 2] = clampByte(blue)
  }
  return output
}
