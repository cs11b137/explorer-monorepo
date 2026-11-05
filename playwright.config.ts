import { defineConfig } from '@playwright/test';

const PORT = 5199;
const ORIGIN = `http://localhost:${PORT}`;
const MODULES = ['protocol', 'os', 'algo', 'codegen', 'cpu', 'db'];

export default defineConfig({
  timeout: 240_000,
  fullyParallel: true,
  reporter: [['list']],
  use: { viewport: { width: 1440, height: 900 } },
  projects: [
    { name: 'portal', testDir: 'e2e', use: { baseURL: `${ORIGIN}/` } },
    ...MODULES.map((name) => ({ name, testDir: `modules/${name}/e2e`, use: { baseURL: `${ORIGIN}/modules/${name}/` } })),
  ],
  // 针对生产构建测试，CSP 这类问题只在这里才会暴露。
  webServer: { command: `npx vite build && npx vite preview --port ${PORT} --strictPort`, port: PORT, reuseExistingServer: false },
});
