import { defineConfig } from '@playwright/test';

const backendOrigin = 'http://127.0.0.1:3015';
const frontendOrigin = 'http://127.0.0.1:5180';

export default defineConfig({
  testDir: './e2e',
  use: {
    baseURL: frontendOrigin,
    browserName: 'chromium',
    headless: true,
  },
  reporter: 'list',
  webServer: [
    {
      command: 'npm run server',
      url: `${backendOrigin}/api/health`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        NODE_ENV: 'test',
        PORT: '3015',
        DB_PATH: ':memory:',
        CLIENT_ORIGIN: frontendOrigin,
      },
    },
    {
      command: 'npm run client -- --host 127.0.0.1 --port 5180 --strictPort',
      url: frontendOrigin,
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        VITE_SOCKET_URL: backendOrigin,
        VITE_API_PROXY_TARGET: backendOrigin,
      },
    },
  ],
});
