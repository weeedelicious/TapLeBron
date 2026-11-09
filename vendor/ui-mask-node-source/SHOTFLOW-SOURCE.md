# 来源

2026-11-04 从 http://172.26.167.216/（infinite-canvas-video，Vite 开发服务器）用 `?raw` 原样取回的源码，
整体替换了此前的 ui-mask-node-source 快照。

Shotflow 只改了这几处：
- server/uiMaskApi.js 的来源校验沿用旧版的放宽写法：经 nginx 转发时 Host 会变，按 x-forwarded-host 比对并忽略端口，否则所有请求都被拒（「仅允许当前本机页面操作」）。
- src/ui/UiMaskEditor.js、src/ui/UiMaskExperiment.js 去掉 `import './*.css'`，样式由 public/ui-mask-bridge.js 加载。

保留的本机数据（不在源码里）：.hud-research/（Python 环境与模型）、outputs/（任务与整板模型）、server/ui-mask-reviewed-layouts/。
tools/ui_mask_lab/ 只取到 contour_annotations.py；实验模型的其余依赖与候选权重 216 上不可下载，相关实验方案不可用。
