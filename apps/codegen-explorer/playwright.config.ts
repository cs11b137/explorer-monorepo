import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  timeout: 240_000,
  fullyParallel: true,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:5202', viewport: { width: 1440, height: 900 } },
  // 针对生产构建测试，CSP 这类问题只在这里才会暴露。
  webServer: { command: 'npx vite build && npx vite preview --port 5202 --strictPort', port: 5202, reuseExistingServer: false },
});
