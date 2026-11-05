import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  timeout: 180_000,
  fullyParallel: true,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:5197', viewport: { width: 1440, height: 900 } },
  webServer: { command: 'npx vite preview --port 5197 --strictPort', port: 5197, reuseExistingServer: false },
});
