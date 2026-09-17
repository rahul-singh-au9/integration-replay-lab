import { defineConfig, devices } from '@playwright/test';
const baseURL = process.env.BASE_URL ?? 'http://127.0.0.1:8791';
export default defineConfig({
  testDir:'./tests', testMatch:'**/*.spec.ts', fullyParallel:false, workers:1, retries:process.env.CI ? 1 : 0,
  reporter:[['list'],['html',{open:'never'}]],
  use:{baseURL,trace:'retain-on-failure',screenshot:'only-on-failure'},
  projects:[{name:'chromium',use:{...devices['Desktop Chrome']}}],
  webServer:process.env.BASE_URL ? undefined : {
    command:'npm run build && wrangler d1 migrations apply integration-replay-lab --local --persist-to .wrangler/test-state && wrangler dev --ip 127.0.0.1 --port 8791 --local --persist-to .wrangler/test-state',
    url:`${baseURL}/api/health`,reuseExistingServer:false,timeout:120_000,
  },
});
