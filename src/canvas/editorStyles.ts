/**
 * 编辑器各功能的样式，按拆分前打包出来的顺序在入口处提前引入。
 *
 * 画布编辑器改成按需加载后（App.tsx 的 lazy），这些样式原本会跟着编辑器代码排到全局样式
 * （tailwind / styles.css）后面，反过来盖掉 styles.css 里的覆盖规则。这里先引入，
 * 打出来的 css 和拆分前逐条一致（vite.config.mjs 里 cssCodeSplit: false，只有一个 css 文件）。
 * 新增功能样式时按它在编辑器里的引入位置插到对应地方。
 */
import "./features/light-stage/light-stage.css";
import "./features/texture-clarity/texture-clarity.css";
import "./features/panorama/panorama-generation-modal.css";
import "./features/panorama/panorama-viewer.css";
import "./features/subject-matting/SubjectMattingModal.css";
import "cropperjs/dist/cropper.css";
import "./components/ImageCropModal.css";
import "tldraw/tldraw.css";
import "./components/ImagePreview.css";
import "./features/director-stage/director-stage.css";
import "./features/atmosphere-transfer/appearance-transfer.css";
import "./features/atmosphere-transfer/atmosphere-transfer.css";
import "./features/atmosphere-transfer/atmosphere-node.css";
import "./features/panorama/panorama-viewer-node.css";
import "./features/image-compare/image-compare.css";
import "./features/video-compare/video-compare.css";
import "./components/CindyAssistantPanel.css";
import "./components/CindyModeSelector.css";
import "./components/PluginTokenModal.css";
import "./components/SkillDocsModal.css";
import "./components/StudioApp.css";
