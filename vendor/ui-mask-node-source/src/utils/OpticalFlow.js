/**
 * 块匹配光流法 - 优化版
 * 修复：重影严重问题
 * 
 * 优化点：
 * 1. 去掉后帧混合（避免双重重影）
 * 2. 缩小块到8×8，边缘更准确
 * 3. 增加置信度判断：匹配不准的块不做warp
 * 4. 用后帧填充空洞，不用灰色
 */

/**
 * 计算两张图片之间的块匹配光流
 */
export function computeBlockMatchingFlow(prevCanvas, nextCanvas, blockSize = 8, searchRange = 24) {
  const w = prevCanvas.width;
  const h = prevCanvas.height;
  
  const prevCtx = prevCanvas.getContext('2d', { willReadFrequently: true });
  const nextCtx = nextCanvas.getContext('2d', { willReadFrequently: true });
  const prevData = prevCtx.getImageData(0, 0, w, h).data;
  const nextData = nextCtx.getImageData(0, 0, w, h).data;
  
  const blocksX = Math.ceil(w / blockSize);
  const blocksY = Math.ceil(h / blockSize);
  const vectorCount = blocksX * blocksY;
  
  // 运动向量场 + 置信度
  const vectors = new Float32Array(vectorCount * 3); // dx, dy, confidence
  
  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      const blockIdx = by * blocksX + bx;
      const startX = bx * blockSize;
      const startY = by * blockSize;
      
      let bestSAD = Infinity;
      let bestDx = 0;
      let bestDy = 0;
      
      const minX = Math.max(0, startX - searchRange);
      const maxX = Math.min(w - blockSize, startX + searchRange);
      const minY = Math.max(0, startY - searchRange);
      const maxY = Math.min(h - blockSize, startY + searchRange);
      
      for (let dy = minY; dy <= maxY; dy += 2) {
        for (let dx = minX; dx <= maxX; dx += 2) {
          let sad = 0;
          for (let y = 0; y < blockSize; y += 1) {
            for (let x = 0; x < blockSize; x += 1) {
              const px1 = startX + x;
              const py1 = startY + y;
              const px2 = dx + x;
              const py2 = dy + y;
              
              if (px1 >= w || py1 >= h || px2 >= w || py2 >= h) continue;
              
              const i1 = (py1 * w + px1) * 4;
              const i2 = (py2 * w + px2) * 4;
              
              sad += Math.abs(prevData[i1] - nextData[i2]);
              sad += Math.abs(prevData[i1 + 1] - nextData[i2 + 1]);
              sad += Math.abs(prevData[i1 + 2] - nextData[i2 + 2]);
            }
          }
          
          if (sad < bestSAD) {
            bestSAD = sad;
            bestDx = dx - startX;
            bestDy = dy - startY;
          }
        }
      }
      
      vectors[blockIdx * 3] = bestDx;
      vectors[blockIdx * 3 + 1] = bestDy;
      // 置信度：SAD越小，匹配越准
      // 阈值：超过这个值的块，认为匹配不准，不做warp
      vectors[blockIdx * 3 + 2] = bestSAD;
    }
  }
  
  return { vectors, w, h, blockSize, blocksX, blocksY };
}

/**
 * 生成中间帧：前向warp + 后帧填充空洞
 * 不做混合，避免双重重影
 */
export function generateIntermediateFrame(prevImage, nextImage, t = 0.5) {
  const w = prevImage.width;
  const h = prevImage.height;
  
  const prevCanvas = document.createElement('canvas');
  prevCanvas.width = w;
  prevCanvas.height = h;
  prevCanvas.getContext('2d').drawImage(prevImage, 0, 0);
  
  const nextCanvas = document.createElement('canvas');
  nextCanvas.width = w;
  nextCanvas.height = h;
  nextCanvas.getContext('2d').drawImage(nextImage, 0, 0);
  
  // 1. 计算光流
  const flow = computeBlockMatchingFlow(prevCanvas, nextCanvas, 8, 24);
  const { vectors, blockSize, blocksX, blocksY } = flow;
  
  // 2. 创建输出缓冲区
  const outputCanvas = document.createElement('canvas');
  outputCanvas.width = w;
  outputCanvas.height = h;
  const ctx = outputCanvas.getContext('2d');
  
  // 先铺后帧作为底图（t=1的位置）
  ctx.drawImage(nextCanvas, 0, 0);
  
  const outputData = ctx.getImageData(0, 0, w, h);
  const prevCtx = prevCanvas.getContext('2d', { willReadFrequently: true });
  const prevData = prevCtx.getImageData(0, 0, w, h).data;
  
  // 记录哪些像素已经被前帧warp覆盖
  const covered = new Uint8Array(w * h);
  
  // 3. 前向warp：把前帧沿运动向量推到中间位置
  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      const blockIdx = by * blocksX + bx;
      const dx = vectors[blockIdx * 3] * t;
      const dy = vectors[blockIdx * 3 + 1] * t;
      const sad = vectors[blockIdx * 3 + 2];
      
      // 置信度判断：SAD太大说明匹配不准，不做warp（避免拖影）
      // 块大小是8×8=64像素，每像素3通道，最大SAD=64*3*255=48960
      // 阈值设为 8000，超过的认为匹配失败
      const confidenceThreshold = 8000;
      if (sad > confidenceThreshold) continue;
      
      const startX = bx * blockSize;
      const startY = by * blockSize;
      
      // 把块内的每个像素移动到新位置
      for (let y = 0; y < blockSize; y++) {
        for (let x = 0; x < blockSize; x++) {
          const srcX = startX + x;
          const srcY = startY + y;
          const dstX = Math.round(startX + x + dx);
          const dstY = Math.round(startY + y + dy);
          
          if (srcX >= w || srcY >= h || dstX >= w || dstY >= h || dstX < 0 || dstY < 0) continue;
          
          const srcIdx = (srcY * w + srcX) * 4;
          const dstIdx = (dstY * w + dstX) * 4;
          
          outputData.data[dstIdx] = prevData[srcIdx];
          outputData.data[dstIdx + 1] = prevData[srcIdx + 1];
          outputData.data[dstIdx + 2] = prevData[srcIdx + 2];
          outputData.data[dstIdx + 3] = 255;
          covered[dstY * w + dstX] = 1;
        }
      }
    }
  }
  
  ctx.putImageData(outputData, 0, 0);
  
  // 4. 对于 t 接近 0 的情况（接近前帧），没被覆盖的区域用前帧填充
  // 对于 t 接近 1 的情况（接近后帧），已经铺了后帧底图，不需要填
  
  // 如果 t < 0.5，更多地使用前帧
  if (t < 0.5) {
    // 没被warp覆盖的地方，用前帧填充（权重随t变化）
    ctx.globalAlpha = 0.5;
    ctx.drawImage(prevCanvas, 0, 0);
    ctx.globalAlpha = 1;
  }
  
  return outputCanvas;
}
