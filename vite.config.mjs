import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src/canvas', import.meta.url))
    }
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:3020',
      '/assets': 'http://127.0.0.1:3020'
    }
  }
});
