import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { setTimeout as pause } from 'node:timers/promises';

// Run one mode at a time against the owned deployment, allowing the write window
// to expire between modes. This script never retries a run creation.
const { values } = parseArgs({
  options: {
    'base-url': { type: 'string' },
    mode: { type: 'string', default: 'smoke' },
    'worker-name': { type: 'string', default: 'integration-replay-lab' },
    prefix: { type: 'string', default: 'live-check' },
    'dry-run': { type: 'boolean', default: false },
  },
});
const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
check(values['base-url'], 'Supply --base-url with the owned HTTPS workers.dev application URL.');
check(
  /^integration-replay-lab(?:-[a-z0-9]+)*$/.test(values['worker-name']) &&
    values['worker-name'].length <= 63,
  '--worker-name must be integration-replay-lab or an explicitly named suffix of it.',
);
check(/^[a-z][a-z0-9-]{0,30}$/.test(values.prefix), '--prefix must be a short lowercase label.');
const base = new URL(values['base-url']);
check(
  base.protocol === 'https:' &&
    new RegExp(`^${values['worker-name']}\\.[a-z0-9-]+\\.workers\\.dev$`).test(base.hostname) &&
    !base.port &&
    !base.username &&
    !base.password &&
    base.pathname === '/' &&
    !base.search &&
    !base.hash,
  '--base-url must be the HTTPS origin of the named workers.dev application.',
);
check(
  ['smoke', 'max-payload', 'invalid', 'rate-limit'].includes(values.mode),
  '--mode must be smoke, max-payload, invalid, or rate-limit.',
);
const marker = `${values.prefix}-${randomUUID()}`;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const ownedIds = new Set();
const summary = {
  mode: values.mode,
  origin: base.origin,
  marker,
  startedAt: new Date().toISOString(),
  timingScope: 'HTTP wall time only; not Worker CPU time',
  observations: [],
  unknownSaveOutcome: false,
};
let cookie;
let cooldownUntil = 0;

async function request(label, route, { method = 'GET', body, origin = base.origin } = {}) {
  check(
    ['/', '/api/health', '/api/session', '/api/runs', '/api/verification-missing'].includes(
      route,
    ) ||
      (route.startsWith('/api/runs/') && uuid.test(route.slice('/api/runs/'.length))),
    'Verification route is outside the fixed allowlist.',
  );
  if (method === 'DELETE') {
    check(ownedIds.has(route.slice('/api/runs/'.length)), 'Refusing an unowned run deletion.');
  }
  const headers = { 'X-Verification-Run': marker };
  if (cookie) headers.Cookie = cookie;
  if (method !== 'GET') headers.Origin = origin;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const started = performance.now();
  let response;
  let text;
  try {
    response = await fetch(new URL(route, base), {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    text = await response.text();
  } catch {
    throw new Error(`${label}: transport failed; no automatic retry was performed.`);
  }
  const requestId = response.headers.get('X-Request-ID');
  summary.observations.push({
    check: label,
    method,
    route,
    status: response.status,
    httpElapsedMs: Number((performance.now() - started).toFixed(2)),
    ...(uuid.test(requestId ?? '') ? { requestId } : {}),
  });
  if (response.status === 429) {
    const seconds = Number(response.headers.get('Retry-After'));
    check(Number.isInteger(seconds) && seconds >= 1 && seconds <= 60, 'Invalid Retry-After.');
    cooldownUntil = Date.now() + seconds * 1_000 + 1_000;
    summary.retryAfterSeconds = seconds;
  }
  return {
    status: response.status,
    headers: response.headers,
    text,
    json() {
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`${label}: expected valid JSON.`);
      }
    },
  };
}

function acceptSession(response) {
  check(response.status === 200, 'Session creation did not succeed.');
  const setCookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith('__Host-irl_session='));
  check(
    /^__Host-irl_session=[a-f0-9]{64};/.test(setCookie ?? '') &&
      /;\s*HttpOnly(?:;|$)/i.test(setCookie) &&
      /;\s*Secure(?:;|$)/i.test(setCookie) &&
      /;\s*SameSite=Strict(?:;|$)/i.test(setCookie) &&
      /;\s*Path=\/(?:;|$)/i.test(setCookie) &&
      !/;\s*Domain=/i.test(setCookie),
    'Session cookie protections are incomplete.',
  );
  cookie = setCookie.split(';')[0];
  const body = response.json();
  check(body.retentionDays === 30 && body.maxRuns === 20, 'Unexpected session limits.');
}

function maximumScenario(kind) {
  const id = (prefix, index) => `${prefix}${String(index).padStart(63, '0')}`;
  return {
    schemaVersion: 1,
    id: `maximum-${kind}-${randomUUID()}`,
    title: `Synthetic maximum ${kind} verification ${marker}`,
    origin: 'fixture',
    events: Array.from({ length: 50 }, (_, index) => ({
      recordId: id('r', index),
      eventId: id('e', index),
      orderId: id('o', index),
      revision: Number.MAX_SAFE_INTEGER,
      status: 'paid',
      totalCents: Number.MAX_SAFE_INTEGER,
      occurredAt: '2026-09-17T00:00:00Z',
    })),
    deliveries: Array.from({ length: 100 }, (_, index) => ({
      id: id('d', index),
      recordId: id('r', index % 50),
      atMs: 0,
      fault:
        kind === 'permanent' || (kind === 'mixed' && index % 2 !== 0)
          ? 'unavailable'
          : 'timeout-after',
    })),
  };
}

function computeLocally(scenario) {
  const directory = mkdtempSync(join(tmpdir(), 'integration-replay-verification-'));
  try {
    const path = join(directory, 'scenario.json');
    writeFileSync(path, JSON.stringify(scenario), { mode: 0o600 });
    const output = execFileSync(
      process.execPath,
      [fileURLToPath(new URL('../dist-cli/cli.js', import.meta.url)), path],
      {
        encoding: 'utf8',
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    return JSON.parse(output);
  } catch {
    throw new Error('Local replay comparison failed. Run npm run build:cli before this check.');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function prepareMaximums() {
  return ['mixed', 'permanent', 'timeout'].map((kind) => {
    const scenario = maximumScenario(kind);
    const result = computeLocally(scenario);
    const inputBytes = Buffer.byteLength(JSON.stringify(scenario));
    const resultBytes = Buffer.byteLength(JSON.stringify(result));
    check(
      inputBytes <= 65_536 && resultBytes <= 512 * 1024,
      'Maximum scenario exceeded storage bounds.',
    );
    const combinedAttempts = result.strategies.reduce(
      (total, strategy) => total + strategy.attempts.length,
      0,
    );
    check(
      combinedAttempts === (kind === 'mixed' ? 500 : kind === 'permanent' ? 600 : 400),
      'Unexpected maximum retry schedule.',
    );
    check(
      result.strategies[1].metrics.duplicateEffects === 0,
      'Guarded replay repeated an effect.',
    );
    return { kind, scenario, result, inputBytes, resultBytes, combinedAttempts };
  });
}

async function smoke() {
  if (values['dry-run']) {
    summary.networkRequests = 0;
    summary.plannedWrites = 0;
    return;
  }
  const page = await request('static page', '/');
  check(
    page.status === 200 && page.text.includes('Integration Replay Lab'),
    'Static application is unavailable.',
  );
  for (const [header, expected] of [
    ['X-Content-Type-Options', 'nosniff'],
    ['X-Frame-Options', 'DENY'],
    ['Referrer-Policy', 'no-referrer'],
    ['Cross-Origin-Resource-Policy', 'same-origin'],
  ])
    check(page.headers.get(header) === expected, `Missing static protection: ${header}.`);
  check(
    page.headers.get('Content-Security-Policy')?.includes("frame-ancestors 'none'"),
    'Static CSP is missing.',
  );
  check(
    page.headers.get('Strict-Transport-Security')?.includes('max-age=31536000'),
    'Static HSTS is missing.',
  );
  const health = await request('database health', '/api/health');
  check(health.status === 200 && health.json().ok === true, 'Database-backed health check failed.');
  check(health.headers.get('Cache-Control') === 'no-store', 'API responses must not be cached.');
  check(
    (await request('anonymous session', '/api/session')).status === 401,
    'Anonymous session did not return 401.',
  );
  check(
    (await request('anonymous library', '/api/runs')).status === 401,
    'Anonymous library did not return 401.',
  );
  check(
    (await request('unknown route', '/api/verification-missing')).status === 404,
    'Unknown endpoint did not return 404.',
  );
  const method = await request('unsupported method', '/api/runs', { method: 'PUT', body: {} });
  check(
    method.status === 405 && method.headers.get('Allow') === 'GET, POST',
    'Method rejection is incorrect.',
  );
  check(
    (
      await request('cross-origin mutation', '/api/session', {
        method: 'POST',
        body: {},
        origin: 'https://example.invalid',
      })
    ).status === 403,
    'Cross-origin mutation did not return 403.',
  );
}

async function verifyMaxPayload() {
  const cases = prepareMaximums();
  summary.cases = cases.map(({ kind, inputBytes, resultBytes, combinedAttempts }) => ({
    kind,
    inputBytes,
    resultBytes,
    combinedAttempts,
  }));
  summary.inputScope =
    'Each scenario contains 50 events, 100 deliveries and maximum-length identifiers and safe integers. Timestamp precision and field lengths keep this valid workload near 36 KiB; it is not an exactly 64 KiB JSON payload.';
  if (values['dry-run']) {
    summary.networkRequests = 0;
    summary.plannedWrites = 7;
    return;
  }
  acceptSession(
    await request('create synthetic session', '/api/session', { method: 'POST', body: {} }),
  );
  for (const item of cases) {
    summary.unknownSaveOutcome = true;
    const saved = await request(`save maximum ${item.kind} scenario`, '/api/runs', {
      method: 'POST',
      body: { scenario: item.scenario },
    });
    if (saved.status >= 400 && saved.status < 500) summary.unknownSaveOutcome = false;
    check(saved.status === 201, `Maximum ${item.kind} scenario was not saved.`);
    const run = saved.json().run;
    check(uuid.test(run?.id ?? ''), 'Save response did not identify the created run.');
    ownedIds.add(run.id);
    summary.unknownSaveOutcome = false;
    check(
      isDeepStrictEqual(run.scenario, item.scenario),
      'Saved scenario differed from the submitted synthetic scenario.',
    );
    check(
      isDeepStrictEqual(run.result, item.result),
      'Server replay differed from the complete local CLI result.',
    );
    const retrieved = await request(`read maximum ${item.kind} scenario`, `/api/runs/${run.id}`);
    check(retrieved.status === 200, 'Stored maximum scenario could not be read.');
    const opened = retrieved.json().run;
    check(
      isDeepStrictEqual(opened?.scenario, item.scenario) &&
        isDeepStrictEqual(opened?.result, item.result),
      'Stored scenario or result did not round-trip.',
    );
  }
}

async function invalid() {
  if (values['dry-run']) {
    summary.networkRequests = 0;
    summary.plannedWrites = 4;
    return;
  }
  acceptSession(
    await request('create synthetic session', '/api/session', { method: 'POST', body: {} }),
  );
  for (const [key, limit] of [
    ['events', 50],
    ['deliveries', 100],
  ]) {
    const scenario = {
      schemaVersion: 1,
      id: 'malformed-array',
      title: `Synthetic malformed-array verification ${marker}`,
      origin: 'fixture',
      events: [],
      deliveries: [],
      [key]: Array(12_000).fill(null),
    };
    check(
      Buffer.byteLength(JSON.stringify(scenario)) < 65_536,
      'Malformed array must remain below the byte limit.',
    );
    const response = await request(`reject excessive ${key} array`, '/api/runs', {
      method: 'POST',
      body: { scenario },
    });
    check(
      response.status === 400 && response.json().error === `${key}: Use at most ${limit} items.`,
      'Excessive array was not rejected by the collection preflight.',
    );
  }
  const oversized = await request('reject oversized request', '/api/runs', {
    method: 'POST',
    body: { scenario: 'x'.repeat(66_561) },
  });
  check(oversized.status === 413, 'Oversized request did not return 413.');
  const runs = await request('malformed input did not save', '/api/runs');
  check(
    runs.status === 200 && runs.json().runs?.length === 0,
    'Malformed input created a saved run.',
  );
}

async function rateLimit() {
  if (values['dry-run']) {
    summary.networkRequests = 0;
    summary.plannedWrites = 'At most 15 session requests';
    return;
  }
  summary.rateLimitObserved = false;
  for (let attempt = 1; attempt <= 15; attempt++) {
    const response = await request(`bounded session limit probe ${attempt}`, '/api/session', {
      method: 'POST',
      body: {},
    });
    if (response.status === 429) {
      summary.rateLimitObserved = true;
      break;
    }
    acceptSession(response);
    if (attempt < 15) await pause(100);
  }
  summary.recovery =
    'Caller must wait at least 61 seconds after the final write, then run invalid or max-payload to verify writes recover.';
  if (!summary.rateLimitObserved) {
    summary.result = 'inconclusive';
    summary.reason =
      'No rejection observed within 15 requests; approximate counters were not load-tested further.';
    process.exitCode = 2;
  }
}

try {
  if (values.mode === 'smoke') await smoke();
  else if (values.mode === 'max-payload') await verifyMaxPayload();
  else if (values.mode === 'invalid') await invalid();
  else await rateLimit();
  summary.result ??= 'passed';
} catch (error) {
  summary.result = 'failed';
  summary.error = error instanceof Error ? error.message : 'Verification failed.';
  process.exitCode = 1;
} finally {
  if (ownedIds.size && cooldownUntil > Date.now()) {
    console.log(JSON.stringify({ cleanupWaitingForRateLimit: true, remainingRuns: ownedIds.size }));
    await pause(cooldownUntil - Date.now());
  }
  for (const id of ownedIds) {
    try {
      const response = await request('delete identified synthetic run', `/api/runs/${id}`, {
        method: 'DELETE',
      });
      if (response.status === 200 || response.status === 404) ownedIds.delete(id);
      if (response.status === 429) break;
    } catch {
      // Each identified run receives at most one cleanup attempt.
    }
  }
  summary.remainingRunIds = [...ownedIds];
  if (ownedIds.size || summary.unknownSaveOutcome) {
    summary.result = 'failed';
    summary.cleanup =
      'Manual review required for only the listed IDs or this exact synthetic title marker.';
    process.exitCode = 1;
  }
  cookie = undefined;
  summary.finishedAt = new Date().toISOString();
  console.log(JSON.stringify(summary, null, 2));
}
