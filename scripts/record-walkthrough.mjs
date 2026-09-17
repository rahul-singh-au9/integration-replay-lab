import { chromium, expect } from '@playwright/test';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const baseURL = process.env.BASE_URL ?? 'http://127.0.0.1:8790';
if (!['127.0.0.1', 'localhost'].includes(new URL(baseURL).hostname))
  throw new Error('The walkthrough creates synthetic records. Use a local preview.');
const output = fileURLToPath(new URL('../.artifacts/walkthrough/', import.meta.url));
await mkdir(output, { recursive: true });
const pauseMs = Number(process.env.RECORD_PAUSE_MS ?? 3000);
if (!Number.isFinite(pauseMs) || pauseMs < 0 || pauseMs > 30_000)
  throw new Error('RECORD_PAUSE_MS must be between 0 and 30000.');
const browser = await chromium.launch({ slowMo: 180 });
const recordings = [];

async function record(name, viewport, journey) {
  const context = await browser.newContext({
    viewport,
    recordVideo: { dir: output, size: viewport },
    acceptDownloads: true,
  });
  const page = await context.newPage();
  const started = Date.now();
  const chapters = [];
  const errors = [];
  const ownedRuns = new Set();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', async (response) => {
    if (
      response.url().endsWith('/api/runs') &&
      response.request().method() === 'POST' &&
      response.status() === 201
    ) {
      try {
        ownedRuns.add((await response.json()).run.id);
      } catch {
        /* The journey separately verifies the save response. */
      }
    }
  });
  const hold = (factor = 1) => page.waitForTimeout(pauseMs * factor);
  const chapter = async (title, note = '') => {
    chapters.push({ seconds: Number(((Date.now() - started) / 1000).toFixed(2)), title, note });
    console.log(`${name}: ${title}`);
  };
  let completed = false;
  try {
    await page.goto(baseURL);
    await expect(page.getByRole('button', { name: 'Run locally', exact: true })).toBeVisible();
    await journey({ page, context, hold, chapter });
    expect(errors).toEqual([]);
    completed = true;
  } finally {
    await page.unroute('**/api/**');
    for (const id of ownedRuns) {
      await context.request
        .delete(`${baseURL}/api/runs/${encodeURIComponent(id)}`, {
          headers: { Origin: new URL(baseURL).origin },
        })
        .catch(() => {});
    }
    await context.close();
    const original = await page.video().path();
    const filename = `${name}${completed ? '' : '-incomplete'}.webm`;
    await rename(original, `${output}/${filename}`);
    recordings.push({
      name,
      filename,
      viewport,
      completed,
      durationSeconds: Number(((Date.now() - started) / 1000).toFixed(2)),
      chapters,
      errors,
    });
    await writeFile(
      `${output}/chapters.json`,
      JSON.stringify({ baseURL, recordedAt: new Date().toISOString(), recordings }, null, 2),
    );
  }
}

async function runLocally(page) {
  await page.getByRole('button', { name: 'Run locally', exact: true }).click();
  await expect(page.getByText('Local replay · Not saved', { exact: true })).toBeVisible();
}
async function download(page, name = 'Export JSON') {
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name, exact: true }).click();
  const file = await downloading;
  const value = JSON.parse(await readFile(await file.path(), 'utf8'));
  await file.saveAs(`${output}/${file.suggestedFilename()}`);
  return value;
}
async function importValue(page, value) {
  await page.getByRole('button', { name: 'Import scenario', exact: true }).click();
  await page.getByLabel('Scenario JSON', { exact: true }).fill(JSON.stringify(value, null, 2));
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Import scenario', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}
async function navigateMobile(page, name) {
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await page.getByRole('dialog', { name: 'Main navigation' }).getByRole('button', { name }).click();
}
const fixtureNames = [
  'The same event arrives twice',
  'An older revision arrives late',
  'Commit succeeds, acknowledgement is lost',
  'Unavailable endpoint exhausts retries',
];

try {
  await record(
    'integration-replay-lab-desktop',
    { width: 1440, height: 1000 },
    async ({ page, hold, chapter }) => {
      await chapter(
        'Local integration workbench and private storage',
        'Actual Worker API and D1 persistence. All scenarios are synthetic.',
      );
      await expect(page.getByText('Private browser session', { exact: true })).toBeVisible();
      await hold();
      const examples = [];
      for (let index = 0; index < fixtureNames.length; index++) {
        await chapter(`Example ${index + 1}: ${fixtureNames[index]}`);
        await page
          .locator('.scenario-nav')
          .getByRole('button', { name: new RegExp(fixtureNames[index]) })
          .click();
        await runLocally(page);
        await page.locator('.strategy-cards').scrollIntoViewIfNeeded();
        await hold();
        for (const strategy of ['Naive consumer', 'Guarded consumer']) {
          await page.getByRole('button', { name: strategy, exact: true }).click();
          await page.locator('.attempt-button').last().click();
          await page
            .getByRole('region', { name: 'Selected delivery evidence' })
            .scrollIntoViewIfNeeded();
          await hold();
        }
        if (index === 0) {
          for (const summary of [
            'View simulated side effects',
            'View source snapshot',
            'View raw attempt',
          ]) {
            await page.getByText(summary, { exact: true }).click();
            await page.locator('.raw-details[open]').scrollIntoViewIfNeeded();
            await hold();
            await page.getByText(summary, { exact: true }).click();
          }
        }
        if (index === 2) {
          await page.locator('.attempt-button').first().click();
          await page
            .getByRole('region', { name: 'Selected delivery evidence' })
            .scrollIntoViewIfNeeded();
          await hold();
        }
        if (index === 3) {
          await page.locator('.dead-letter-section').scrollIntoViewIfNeeded();
          await hold();
        }
        examples.push(await download(page));
      }

      await chapter(
        'Import full snapshots: identity conflicts, revision conflicts and multiple orders',
      );
      const original = structuredClone(examples[0].scenario.events[0]);
      const custom = {
        schemaVersion: 1,
        id: 'conflict-and-retry-investigation',
        title: 'Conflicting snapshots and another order',
        origin: 'imported',
        events: [
          original,
          { ...original, recordId: 'identity-collision', totalCents: original.totalCents + 100 },
          {
            ...original,
            recordId: 'revision-collision',
            eventId: 'event-conflicting-revision',
            status: 'cancelled',
          },
          {
            ...original,
            recordId: 'another-order',
            eventId: 'event-another-order',
            orderId: 'order-2007',
            revision: 1,
            status: 'created',
          },
        ],
        deliveries: [
          { id: 'delivery-original', recordId: original.recordId, atMs: 0, fault: 'none' },
          {
            id: 'delivery-identity-collision',
            recordId: 'identity-collision',
            atMs: 100,
            fault: 'none',
          },
          {
            id: 'delivery-revision-collision',
            recordId: 'revision-collision',
            atMs: 200,
            fault: 'none',
          },
          {
            id: 'delivery-timeout-before',
            recordId: 'another-order',
            atMs: 300,
            fault: 'timeout-before',
          },
        ],
      };
      await importValue(page, custom);
      await runLocally(page);
      await page.locator('.strategy-cards').scrollIntoViewIfNeeded();
      await hold();
      for (const index of [1, 2, 3, 4]) {
        await page.locator('.attempt-button').nth(index).click();
        await page
          .getByRole('region', { name: 'Selected delivery evidence' })
          .scrollIntoViewIfNeeded();
        await hold();
      }
      const customBundle = await download(page);

      await chapter('Edit scenario JSON and recompute after changing a fault');
      await page.getByRole('button', { name: 'Edit scenario JSON', exact: true }).click();
      const edited = structuredClone(custom);
      edited.title = 'Conflict investigation with an acknowledged second order';
      edited.deliveries[3].fault = 'none';
      await page.getByLabel('Scenario JSON', { exact: true }).fill(JSON.stringify(edited, null, 2));
      await hold();
      await page.getByRole('button', { name: 'Apply scenario', exact: true }).click();
      await expect(page.getByText('Local replay · Not saved', { exact: true })).toHaveCount(0);
      await runLocally(page);
      await hold();
      await page.getByRole('button', { name: 'Scenario JSON', exact: true }).click();
      await page.locator('.raw-scenario').scrollIntoViewIfNeeded();
      await hold();

      await chapter('Server replay: compute, save and survive a reload');
      await importValue(page, examples[2]);
      const created = page.waitForResponse(
        (response) =>
          response.url().endsWith('/api/runs') && response.request().method() === 'POST',
      );
      await page.getByRole('button', { name: 'Run and save', exact: true }).click();
      const response = await created;
      expect(response.status()).toBe(201);
      const { run } = await response.json();
      await expect(page.getByText('Saved replay · Server result', { exact: true })).toBeVisible();
      await hold();
      await page.reload();
      await page.getByRole('button', { name: /^Saved replays/ }).click();
      await expect(page.getByRole('heading', { name: run.title, exact: true })).toBeVisible();
      await hold();
      await download(page, `Export ${run.title}`);
      await page.getByRole('button', { name: 'Open', exact: true }).click();
      await expect(page.getByText('Saved replay · Server result', { exact: true })).toBeVisible();
      await page.locator('.strategy-cards').scrollIntoViewIfNeeded();
      await hold();
      await chapter('Review deletion, cancel, then remove the saved replay');
      await page.getByRole('button', { name: /^Saved replays/ }).click();
      await page.getByRole('button', { name: `Delete ${run.title}`, exact: true }).click();
      await hold();
      await page.getByRole('button', { name: 'Keep replay', exact: true }).click();
      await page.getByRole('button', { name: `Delete ${run.title}`, exact: true }).click();
      await page.getByRole('button', { name: 'Delete replay', exact: true }).click();
      await expect(
        page.getByRole('heading', { name: 'A place for repeatable investigations.', exact: true }),
      ).toBeVisible();
      await hold();
      await page.getByRole('button', { name: 'Open workbench', exact: true }).click();
      await expect(page.getByText('Server result · Not saved', { exact: true })).toBeVisible();
      await hold();

      await chapter('Import validation: malformed JSON and unsupported bundle metadata');
      await page.getByRole('button', { name: 'Import scenario', exact: true }).click();
      await page.getByLabel('Scenario JSON', { exact: true }).fill('{');
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Import scenario', exact: true })
        .click();
      await expect(page.getByRole('dialog').getByRole('alert')).toContainText('not valid JSON');
      await hold();
      await page
        .getByLabel('Scenario JSON', { exact: true })
        .fill(JSON.stringify({ ...customBundle, schemaVersion: 99 }, null, 2));
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Import scenario', exact: true })
        .click();
      await expect(page.getByRole('dialog').getByRole('alert')).toContainText(
        'not a supported replay export',
      );
      await hold();
      await chapter('File import: reject malformed UTF-8, then restore a valid export');
      await page.getByLabel('Select scenario JSON file', { exact: true }).setInputFiles({
        name: 'invalid.json',
        mimeType: 'application/json',
        buffer: Buffer.from([0xc3, 0x28]),
      });
      await expect(page.getByRole('dialog').getByRole('alert')).toContainText('not valid UTF-8');
      await hold();
      await page.getByLabel('Select scenario JSON file', { exact: true }).setInputFiles({
        name: 'exported-replay.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(customBundle)),
      });
      await expect(page.getByLabel('Scenario JSON', { exact: true })).toHaveValue(
        JSON.stringify(customBundle),
      );
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Import scenario', exact: true })
        .click();
      await runLocally(page);
      await hold();

      await chapter(
        'Server failure preserves local replay and export',
        'HTTP 503 responses are deliberately injected for this segment.',
      );
      await page.route('**/api/**', (route) =>
        route.fulfill({
          status: 503,
          json: {
            error: 'Storage unavailable for this failure demonstration.',
            requestId: 'walkthrough-failure',
          },
        }),
      );
      await page.reload();
      await expect(page.getByText('Server unavailable', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Run and save', exact: true }).click();
      await expect(page.getByRole('alert')).toContainText('Storage unavailable');
      await hold();
      await runLocally(page);
      await download(page);
      await page.locator('.strategy-cards').scrollIntoViewIfNeeded();
      await hold();
      await page.unroute('**/api/**');
      await page.getByRole('button', { name: 'Retry connection', exact: true }).click();
      await expect(page.getByText('Private browser session', { exact: true })).toBeVisible();
      await hold();

      await chapter('Method: virtual retries, reproducibility and simulation limits');
      await page.getByRole('button', { name: 'How it works', exact: true }).last().click();
      await page.locator('.method-grid').scrollIntoViewIfNeeded();
      await hold();
      await page.locator('.method-note').scrollIntoViewIfNeeded();
      await hold(2);
    },
  );

  await record(
    'integration-replay-lab-mobile',
    { width: 390, height: 844 },
    async ({ page, hold, chapter }) => {
      await chapter('Mobile replay workbench at 390 pixels');
      await hold();
      await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
      await hold();
      await page
        .getByRole('dialog', { name: 'Main navigation' })
        .getByRole('button', { name: new RegExp(fixtureNames[2]) })
        .click();
      await expect(page.getByRole('main')).toBeFocused();
      await runLocally(page);
      await page.locator('.strategy-cards').scrollIntoViewIfNeeded();
      await hold();
      await page.locator('.strategy-card.robust').scrollIntoViewIfNeeded();
      await hold();
      await chapter('Mobile retry evidence and consumer comparison');
      await page.locator('.attempt-button').last().click();
      await page
        .getByRole('region', { name: 'Selected delivery evidence' })
        .scrollIntoViewIfNeeded();
      await hold();
      await page.getByRole('button', { name: 'Naive consumer', exact: true }).click();
      await page
        .getByRole('region', { name: 'Selected delivery evidence' })
        .scrollIntoViewIfNeeded();
      await hold();
      await page.getByText('View simulated side effects', { exact: true }).click();
      await page.locator('.raw-details[open]').scrollIntoViewIfNeeded();
      await hold();
      await chapter('Mobile import dialog and keyboard focus return');
      await page.getByRole('button', { name: 'Import scenario', exact: true }).click();
      await hold();
      await page.keyboard.press('Escape');
      await expect(
        page.getByRole('button', { name: 'Import scenario', exact: true }),
      ).toBeFocused();
      await chapter('Mobile navigation, empty library and method');
      await navigateMobile(page, /^Saved replays/);
      await expect(page.getByRole('heading', { name: 'Saved replays', exact: true })).toBeVisible();
      await hold();
      await navigateMobile(page, 'How it works');
      await page.locator('.method-note').scrollIntoViewIfNeeded();
      await hold();
      await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
      await page.keyboard.press('Escape');
      await expect(
        page.getByRole('button', { name: 'Open navigation', exact: true }),
      ).toBeFocused();
      await hold();
    },
  );
} finally {
  await browser.close();
}
console.log(`Recordings and chapter timings saved in ${output}`);
