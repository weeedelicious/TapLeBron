/**
 * 数值夹紧工具
 * @param {number} value 输入值
 * @param {number} min 最小值
 * @param {number} max 最大值
 * @returns {number} 夹紧后的值
 */
export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
