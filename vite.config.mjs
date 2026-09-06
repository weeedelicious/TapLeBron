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
  server: {
    proxy: {
      '/api': { target: 'http://127.0.0.1:3020', changeOrigin: true },
      '/assets': { target: 'http://127.0.0.1:3020', changeOrigin: true }
    }
  }
});
