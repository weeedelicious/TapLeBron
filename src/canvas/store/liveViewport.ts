import { create } from "zustand";
import type { Viewport } from "@xyflow/react";

/**
 * 画布视角的实时值（平移 / 缩放每一帧都更新）。
 *
 * 画布主状态（canvasStore.viewport）只在移动停下来时写一次：主状态被画布本体和各个节点
 * 整体订阅，以前每帧写一次，拖动视角时所有看得见的节点每帧都要重新渲染，节点一多就卡。
 * 移动过程中必须跟着走的小东西（多选框、多选工具条、缩放百分比）单独订阅这里，
 * 每帧只重新渲染它们自己。
 */
export const useLiveViewport = create<{ viewport: Viewport }>(() => ({
  viewport: { x: 0, y: 0, zoom: 1 },
}));

export function setLiveViewport(viewport: Viewport) {
  const current = useLiveViewport.getState().viewport;
  if (current.x === viewport.x && current.y === viewport.y && current.zoom === viewport.zoom) return;
  useLiveViewport.setState({ viewport });
}
