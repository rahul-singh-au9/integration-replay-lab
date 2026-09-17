import { defineConfig, devices } from '@playwright/test';

const engines = ['chromium', 'firefox', 'webkit'] as const;
const ports = [8791, 8794, 8796];
export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: engines.map((name, index) => ({
    name,
    use: {
      ...devices[
        name === 'chromium'
          ? 'Desktop Chrome'
          : name === 'firefox'
            ? 'Desktop Firefox'
            : 'Desktop Safari'
      ],
      baseURL: process.env.BASE_URL ?? `http://127.0.0.1:${ports[index]}`,
    },
  })),
  webServer: process.env.BASE_URL
    ? undefined
    : engines.map((name, index) => ({
        command: `wrangler d1 migrations apply integration-replay-lab --local --persist-to .wrangler/test-${name} && wrangler dev --ip 127.0.0.1 --port ${ports[index]} --local --persist-to .wrangler/test-${name}`,
        url: `http://127.0.0.1:${ports[index]}/api/health`,
        reuseExistingServer: false,
        timeout: 120_000,
      })),
});
