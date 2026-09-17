import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const output = new URL('../.artifacts/visual/', import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  await page.goto(process.env.BASE_URL ?? 'http://127.0.0.1:8790');
  await page.getByRole('button', { name: 'Run locally', exact: true }).click();
  await page.getByText('Replay complete', { exact: true }).waitFor();
  await page.screenshot({
    path: fileURLToPath(new URL('desktop-replay.png', output)),
    fullPage: true,
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({
    path: fileURLToPath(new URL('mobile-replay.png', output)),
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'Import scenario', exact: true }).click();
  await page.screenshot({
    path: fileURLToPath(new URL('mobile-import.png', output)),
    animations: 'disabled',
  });
} finally {
  await browser.close();
}
