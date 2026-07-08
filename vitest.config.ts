import { defineConfig } from 'vitest/config';

// core/ 为纯逻辑（零 cc 依赖），可在 Node 下独立单测，不依赖 Cocos 编辑器/运行时。
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
