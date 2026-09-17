import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { fixtures } from '../src/core/fixtures';
import { replayScenario } from '../src/core/replay';
import { MAX_SAVED_EVENTS, MAX_SAVED_DELIVERIES, type Scenario } from '../src/core/schema';

test('server replay persists real computed results and isolates saved runs', async ({
  page,
  browser,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let sessionCreations = 0;
  page.context().on('request', (request) => {
    if (request.url().endsWith('/api/session') && request.method() === 'POST') sessionCreations++;
  });
  const secondTab = await page.context().newPage();
  await Promise.all([page.goto('/'), secondTab.goto('/')]);
  await expect(page.getByText('Private browser session', { exact: true })).toBeVisible();
  await expect(secondTab.getByText('Private browser session', { exact: true })).toBeVisible();
  expect(sessionCreations).toBe(1);
  await secondTab.close();
  const created = page.waitForResponse(
    (r) => r.url().endsWith('/api/runs') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Run and save', exact: true }).click();
  const response = await created;
  expect(response.status()).toBe(201);
  const { run } = await response.json();
  expect(run.scenario).toEqual(fixtures[0].scenario);
  expect(run.result).toEqual(replayScenario(fixtures[0].scenario));
  await expect(page.getByText('Saved replay · Server result', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Selected delivery evidence' })).toBeVisible();
  const cookie = (await page.context().cookies()).find((c) => c.name.endsWith('irl_session'));
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe('Strict');
  expect(cookie?.secure).toBe(new URL(page.url()).protocol === 'https:');

  const other = await browser.newContext();
  const base = new URL(page.url()).origin;
  await other.request.post(`${base}/api/session`, { headers: { Origin: base }, data: {} });
  expect((await other.request.get(`${base}/api/runs/${run.id}`)).status()).toBe(404);
  expect(
    (
      await other.request.delete(`${base}/api/runs/${run.id}`, { headers: { Origin: base } })
    ).status(),
  ).toBe(404);
  await other.close();

  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export JSON', exact: true }).click();
  const bundle = JSON.parse(await readFile((await (await downloading).path())!, 'utf8'));
  expect(bundle.result).toEqual(run.result);
  expect(bundle.scenario).toEqual(run.scenario);
  await page.getByRole('button', { name: 'Import scenario', exact: true }).click();
  await page.getByLabel('Scenario JSON', { exact: true }).fill(JSON.stringify(bundle));
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Import scenario', exact: true })
    .click();
  await expect(page.getByText('Replay complete', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Run locally', exact: true }).click();
  await expect(page.getByText('Local replay · Not saved', { exact: true })).toBeVisible();
  const localDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export JSON', exact: true }).click();
  const localBundle = JSON.parse(await readFile((await (await localDownload).path())!, 'utf8'));
  expect(localBundle.result).toEqual(run.result);

  await page.reload();
  await page.getByRole('button', { name: /^Saved replays/ }).click();
  await expect(page.getByRole('heading', { name: run.title, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.getByText('Saved replay · Server result', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^Saved replays/ }).click();
  await page.getByRole('button', { name: `Delete ${run.title}`, exact: true }).click();
  await page.getByRole('button', { name: 'Delete replay', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'A place for repeatable investigations.', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('main')).toBeFocused();
  await page.getByRole('button', { name: 'Replay workbench', exact: true }).click();
  await expect(page.getByText('Server result · Not saved', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('invalid input and service failures preserve explicit local-only operation', async ({
  page,
}) => {
  await page.route('**/api/**', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Storage unavailable.', requestId: 'test-outage' }),
    }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Import scenario', exact: true }).click();
  await page.getByLabel('Scenario JSON', { exact: true }).fill('{');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Import scenario', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText('not valid JSON');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Run and save', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Storage unavailable');
  await expect(page.getByText('Saved replay · Server result', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Run locally', exact: true }).click();
  await expect(page.getByText('Local replay · Not saved', { exact: true })).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export JSON', exact: true }).click();
  expect((await download).suggestedFilename()).toMatch(/replay\.json$/);
});

test('mobile replay and key views meet accessibility and layout targets', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Run locally', exact: true }).click();
  await expect(page.getByText('Replay complete', { exact: true })).toBeVisible();
  for (const viewport of [
    { width: 1440, height: 960 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(
      results.violations
        .filter((v) => ['serious', 'critical'].includes(v.impact ?? ''))
        .map((v) => ({
          id: v.id,
          nodes: v.nodes.map((n) => ({ target: n.target, reason: n.failureSummary })),
        })),
    ).toEqual([]);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  }
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Open navigation', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await page.getByRole('button', { name: /^Saved replays/ }).click();
  await expect(page.getByRole('heading', { name: 'Saved replays', exact: true })).toBeVisible();
});

test('keyboard import restores focus and renders imported text without executing it', async ({
  page,
}) => {
  const scenario = structuredClone(fixtures[0].scenario);
  scenario.title = '<img src=x onerror="window.injectionRan=true">';
  await page.goto('/');
  await page.getByRole('button', { name: 'Import scenario', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.getByLabel('Scenario JSON', { exact: true }).fill(JSON.stringify(scenario));
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Import scenario', exact: true })
    .focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Import scenario', exact: true })).toBeFocused();
  await expect(page.getByRole('heading', { name: scenario.title, exact: true })).toBeVisible();
  expect(await page.evaluate(() => Reflect.get(window, 'injectionRan'))).toBeUndefined();
  await page.getByRole('button', { name: 'Run locally', exact: true }).click();
  await expect(page.getByText('Replay complete', { exact: true })).toBeVisible();
});

test('method, JSON view and import dialog meet the accessibility target', async ({ page }) => {
  await page.goto('/');
  for (const next of ['How it works', 'Scenario JSON', 'Import scenario']) {
    await page.getByRole('button', { name: next, exact: true }).last().click();
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(
      results.violations
        .filter((v) => ['serious', 'critical'].includes(v.impact ?? ''))
        .map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })),
    ).toEqual([]);
  }
});

test('long imported identifiers and maximum amounts remain usable on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const scenario = structuredClone(fixtures[0].scenario);
  scenario.title = 'A'.repeat(160);
  for (const event of scenario.events) {
    event.orderId = 'order-' + 'a'.repeat(58);
    event.eventId = 'event-' + 'b'.repeat(58);
    event.revision = Number.MAX_SAFE_INTEGER;
    event.totalCents = Number.MAX_SAFE_INTEGER;
  }
  await page.goto('/');
  await page.getByRole('button', { name: 'Import scenario', exact: true }).click();
  await page.getByLabel('Scenario JSON', { exact: true }).fill(JSON.stringify(scenario));
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Import scenario', exact: true })
    .click();
  await page.getByRole('button', { name: 'Run locally', exact: true }).click();
  await expect(page.getByText('Local replay · Not saved', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await expect(
    page.getByText('9,007,199,254,740,991 cents', { exact: true }).first(),
  ).toBeVisible();
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('production assets stay within budget with no third-party page requests', async ({ page }) => {
  const sizes: Promise<number>[] = [];
  const thirdParty: string[] = [];
  page.on('response', (response) => {
    if (['script', 'stylesheet'].includes(response.request().resourceType()))
      sizes.push(response.body().then((body) => gzipSync(body).byteLength));
  });
  page.on('request', (request) => {
    if (
      new URL(request.url()).origin !== new URL(page.url()).origin &&
      !request.isNavigationRequest()
    )
      thirdParty.push(request.url());
  });
  const start = Date.now();
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Run locally', exact: true })).toBeEnabled();
  expect(Date.now() - start).toBeLessThan(10_000);
  await page.waitForLoadState('networkidle');
  const bytes = (await Promise.all(sizes)).reduce((sum, n) => sum + n, 0);
  expect(bytes).toBeLessThan(250 * 1024);
  expect(thirdParty).toEqual([]);
  console.log(
    JSON.stringify({ gzipApplicationAssetBytes: bytes, usableWithinMs: Date.now() - start }),
  );
});

async function stubStorage(page: import('@playwright/test').Page) {
  await page.route('**/api/session', (route) =>
    route.fulfill({ json: { retentionDays: 30, maxRuns: 20 } }),
  );
  await page.route('**/api/runs', (route) => route.fulfill({ json: { runs: [] } }));
}

const savedExample = () => ({
  id: '8adf2cd7-2c72-4ce3-8818-ff272268c746',
  title: fixtures[0].scenario.title,
  origin: fixtures[0].scenario.origin,
  createdAt: '2026-09-17T00:00:00.000Z',
  eventCount: fixtures[0].scenario.events.length,
  scenario: fixtures[0].scenario,
  result: replayScenario(fixtures[0].scenario),
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

test('all examples, editing, strategy evidence and dead letters remain reproducible', async ({
  page,
}) => {
  await stubStorage(page);
  await page.goto('/');
  for (const fixture of fixtures) {
    await page
      .locator('.scenario-nav')
      .getByRole('button', { name: new RegExp(fixture.title) })
      .click();
    await page.getByRole('button', { name: 'Run locally', exact: true }).click();
    await expect(page.getByText('Local replay · Not saved', { exact: true })).toBeVisible();
    for (const strategy of ['Naive consumer', 'Guarded consumer']) {
      await page.getByRole('button', { name: strategy, exact: true }).click();
      await page
        .getByRole('region', { name: 'Delivery attempts', exact: true })
        .locator('.attempt-button')
        .last()
        .click();
      await expect(page.getByRole('region', { name: 'Selected delivery evidence' })).toBeVisible();
    }
    const downloading = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export JSON', exact: true }).click();
    const downloaded = await downloading;
    const bundle = JSON.parse(await readFile((await downloaded.path())!, 'utf8'));
    expect(bundle.result).toEqual(replayScenario(fixture.scenario));
  }
  await page.getByRole('button', { name: 'Edit scenario JSON', exact: true }).click();
  const edited = structuredClone(fixtures[0].scenario);
  edited.title = 'Edited order delivery';
  await page.getByLabel('Scenario JSON', { exact: true }).fill(JSON.stringify(edited));
  await page.getByRole('button', { name: 'Apply scenario', exact: true }).click();
  await expect(page.getByRole('heading', { name: edited.title, exact: true })).toBeVisible();
  await expect(page.getByText('Local replay · Not saved', { exact: true })).toHaveCount(0);
  await expect(page.locator('.origin-tag')).toHaveText('Imported scenario');
});

test('mobile navigation traps focus, restores focus on selection and recovers on resize', async ({
  page,
}) => {
  await stubStorage(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const menu = page.getByRole('button', {
    name: 'Open navigation',
    exact: true,
    includeHidden: true,
  });
  await menu.click();
  const navigation = page.getByRole('dialog', { name: 'Main navigation', exact: true });
  const first = navigation.getByRole('link').first();
  const last = navigation.getByRole('button').last();
  await expect(first).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(last).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(first).toBeFocused();
  await navigation.getByRole('button', { name: /^Saved replays/ }).click();
  await expect(page.getByRole('main')).toBeFocused();
  await menu.click();
  await page.setViewportSize({ width: 1440, height: 960 });
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.main-shell')).not.toHaveAttribute('inert');
  await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe('');
  await page.setViewportSize({ width: 320, height: 740 });
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await menu.click();
  await page.keyboard.press('Escape');
  await expect(menu).toBeFocused();
});

test('late library refresh cannot erase a completed server save', async ({ page }) => {
  await stubStorage(page);
  const pending = deferred();
  const started = deferred();
  const saved = savedExample();
  await page.route('**/api/runs', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({ status: 201, json: { run: saved } });
      return;
    }
    started.resolve();
    await pending.promise;
    await route.fulfill({ json: { runs: [] } });
  });
  await page.goto('/');
  await started.promise;
  await page.getByRole('button', { name: 'Run and save', exact: true }).click();
  await expect(page.getByText('Saved replay · Server result', { exact: true })).toBeVisible();
  const finished = page.waitForResponse(
    (response) => response.url().endsWith('/api/runs') && response.request().method() === 'GET',
  );
  pending.resolve();
  await finished;
  await page.getByRole('button', { name: /^Saved replays/ }).click();
  await expect(page.getByRole('heading', { name: saved.title, exact: true })).toBeVisible();
});

test('late saved replay cannot replace a newly selected scenario', async ({ page }) => {
  await stubStorage(page);
  const saved = savedExample();
  const pending = deferred();
  const started = deferred();
  await page.route('**/api/runs', (route) => route.fulfill({ json: { runs: [saved] } }));
  await page.route(`**/api/runs/${saved.id}`, async (route) => {
    started.resolve();
    await pending.promise;
    await route.fulfill({ json: { run: saved } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: /^Saved replays/ }).click();
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await started.promise;
  await page.locator('.scenario-nav').getByRole('button').nth(1).click();
  const finished = page.waitForResponse((response) =>
    response.url().endsWith(`/api/runs/${saved.id}`),
  );
  pending.resolve();
  await finished;
  await expect(
    page.getByRole('heading', { name: fixtures[1].scenario.title, exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Saved replay · Server result', { exact: true })).toHaveCount(0);
});

test('malformed saved results and unconfirmed deletion remain recoverable', async ({ page }) => {
  await stubStorage(page);
  const saved = savedExample();
  await page.route('**/api/runs', (route) => route.fulfill({ json: { runs: [saved] } }));
  await page.route(`**/api/runs/${saved.id}`, (route) =>
    route.fulfill({
      json:
        route.request().method() === 'DELETE' ? { ok: false } : { run: { ...saved, result: {} } },
    }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: /^Saved replays/ }).click();
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('saved replay is invalid');
  await page.getByRole('button', { name: `Delete ${saved.title}`, exact: true }).click();
  await page.getByRole('button', { name: 'Delete replay', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('invalid response');
  await page.getByRole('button', { name: 'Keep replay', exact: true }).click();
  await expect(page.getByRole('heading', { name: saved.title, exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: `Delete ${saved.title}`, exact: true }),
  ).toBeFocused();
});

test('file imports reject invalid bytes and ignore a cancelled asynchronous read', async ({
  page,
}) => {
  await stubStorage(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Import scenario', exact: true }).click();
  const picker = page.getByLabel('Select scenario JSON file', { exact: true });
  await picker.setInputFiles({
    name: 'invalid.json',
    mimeType: 'application/json',
    buffer: Buffer.from([0xc3, 0x28]),
  });
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('not valid UTF-8');
  await picker.setInputFiles({
    name: 'scenario.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(fixtures[1].scenario)),
  });
  await expect(page.getByLabel('Scenario JSON', { exact: true })).toHaveValue(
    JSON.stringify(fixtures[1].scenario),
  );
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Import scenario', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: fixtures[1].scenario.title, exact: true }),
  ).toBeVisible();

  await page.evaluate(() => {
    const original = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = function () {
      return new Promise<ArrayBuffer>((resolve) => {
        Reflect.set(window, 'finishFileRead', async () => resolve(await original.call(this)));
      });
    };
  });
  await page.getByRole('button', { name: 'Import scenario', exact: true }).click();
  await picker.setInputFiles({
    name: 'slow.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(fixtures[0].scenario)),
  });
  await expect(page.getByRole('button', { name: 'Reading file…', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Import scenario', exact: true }).click();
  const input = page.getByLabel('Scenario JSON', { exact: true });
  await input.fill('newer input');
  await page.evaluate(async () => {
    await Reflect.get(window, 'finishFileRead')();
  });
  await expect(input).toHaveValue('newer input');
});

test('scenarios beyond saved-run limits still replay and export locally without uploading', async ({
  page,
}) => {
  await stubStorage(page);
  const uploads: string[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/api/runs') && request.method() === 'POST')
      uploads.push(request.url());
  });
  await page.goto('/');
  const event = fixtures[0].scenario.events[0];
  const cases: Scenario[] = [
    {
      ...structuredClone(fixtures[0].scenario),
      title: 'More snapshots than saved runs allow',
      origin: 'imported',
      events: Array.from({ length: MAX_SAVED_EVENTS + 1 }, (_, index) => ({
        ...event,
        recordId: `record-${index}`,
        eventId: `event-${index}`,
        orderId: `order-${index}`,
      })),
      deliveries: Array.from({ length: MAX_SAVED_EVENTS + 1 }, (_, index) => ({
        id: `delivery-${index}`,
        recordId: `record-${index}`,
        atMs: index,
        fault: 'none',
      })),
    },
    {
      ...structuredClone(fixtures[0].scenario),
      title: 'More deliveries than saved runs allow',
      origin: 'imported',
      deliveries: Array.from({ length: MAX_SAVED_DELIVERIES + 1 }, (_, index) => ({
        id: `delivery-${index}`,
        recordId: event.recordId,
        atMs: index,
        fault: 'none',
      })),
    },
  ];
  for (const scenario of cases) {
    await page.getByRole('button', { name: 'Import scenario', exact: true }).click();
    await page.getByLabel('Scenario JSON', { exact: true }).fill(JSON.stringify(scenario));
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Import scenario', exact: true })
      .click();
    await expect(page.getByRole('button', { name: 'Run and save', exact: true })).toBeDisabled();
    await expect(page.locator('.notice-info')).toContainText('Run locally and export');
    await expect(page.locator('.notice-info')).not.toContainText('Choose Run and save');
    await expect(page.locator('#saved-run-limit')).toContainText(
      `Saved runs support up to ${MAX_SAVED_EVENTS} snapshots and ${MAX_SAVED_DELIVERIES} deliveries`,
    );
    await page.getByRole('button', { name: 'Run locally', exact: true }).click();
    await expect(page.getByText('Local replay · Not saved', { exact: true })).toBeVisible();
    const downloading = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export JSON', exact: true }).click();
    const downloaded = await downloading;
    const bundle = JSON.parse(await readFile((await downloaded.path())!, 'utf8'));
    expect(bundle.scenario).toEqual(scenario);
    expect(bundle.result).toEqual(replayScenario(scenario));
  }
  expect(uploads).toEqual([]);
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.locator('.scenario-nav').getByRole('button').first().click();
  await expect(page.getByRole('button', { name: 'Run and save', exact: true })).toBeEnabled();
  await expect(page.locator('#saved-run-limit')).toHaveCount(0);
  await page.getByRole('button', { name: 'Import scenario', exact: true }).click();
  await page
    .getByLabel('Scenario JSON', { exact: true })
    .fill(JSON.stringify(fixtures[0].scenario));
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Import scenario', exact: true })
    .click();
  await expect(page.locator('.notice-info')).toContainText('Choose Run and save');
  await expect(page.getByRole('button', { name: 'Run and save', exact: true })).toBeEnabled();
  expect(uploads).toEqual([]);
});
