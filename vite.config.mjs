import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src/canvas', import.meta.url))
    },
    // three 和 tldraw 各自再打一份会触发
    // 「Multiple instances of Three.js」和「multiple instances of some tldraw libraries」。
    // 白板的样式常量从 @tldraw/editor 取（它 re-export tlschema），不要再直连 @tldraw/tlschema。
    dedupe: ['three', 'tldraw', '@tldraw/editor', '@tldraw/store', '@tldraw/tlschema', '@tldraw/state', '@tldraw/state-react', '@tldraw/utils', '@tldraw/validate'],
  },
  build: {
    // 编辑器 / Studio 按需加载（App.tsx 里的 lazy），但样式不拆：仍打成一个 css 文件随入口加载，
    // 顺序和拆分前完全一样。拆开的话功能面板、白板的样式会晚于 styles.css 加载、反过来盖掉我们的覆盖样式。
    cssCodeSplit: false,
  },
  server: {
    proxy: {
      '/api': { target: 'http://127.0.0.1:3020', changeOrigin: true },
      '/assets': { target: 'http://127.0.0.1:3020', changeOrigin: true }
    }
  }
});
