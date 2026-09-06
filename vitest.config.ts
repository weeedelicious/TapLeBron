import { defineConfig } from "vitest/config";
import path from "node:path";

// 只给测试用。故意不叫 vite.config.ts：仓库的生产构建至今是零配置的，
// 一旦出现 vite.config.ts，主 bundle 的分块和文件名都可能变，
// "线上产物 == 源码构建结果"那套哈希等价就得重新证明一次。
// vitest 优先读 vitest.config.*，所以这个文件对 `vite build` 完全没有影响。
export default defineConfig({
  test: {
    environment: "jsdom",
    // .tsx 也收：组件渲染类测试要写 JSX（比如 Cindy 面板的 hook 顺序回归）
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src/canvas"),
    },
  },
});
