import {
  MAX_EVENTS,
  MAX_SCENARIO_BYTES,
  MAX_SAVED_EVENTS,
  MAX_SAVED_DELIVERIES,
  ScenarioSizeError,
  ScenarioValidationError,
} from '../src/core/schema';
import { createReplay } from '../src/core/replay';
import { initializeReplay } from '../src/core/initialize';

initializeReplay();

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  WRITE_LIMITER: { limit(options: { key: string }): Promise<{ success: boolean }> };
  APP_VERSION?: string;
}

const DAY = 86_400_000;
const MAX_RUNS = 20;
const MAX_TOTAL_RUNS = 500;
const MAX_RESULT_BYTES = 512 * 1024;
const RESULT_DIGEST_FORMAT = 'integration-replay-result-digest';
const MAX_DIGEST_ENVELOPE_LENGTH = 256;
const RETENTION_DAYS = 30;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

function json(data: unknown, status = 200, extra: HeadersInit = {}): Response {
  return serializedJson(JSON.stringify(data), status, extra);
}

function serializedJson(body: string, status: number, extra: HeadersInit = {}): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'X-Frame-Options': 'DENY',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
      ...extra,
    },
  });
}

function runResponse(
  summary: ReturnType<typeof metadata>,
  scenarioJson: string,
  resultJson: string,
  status = 200,
): Response {
  // Both large values were already validated and JSON-encoded for integrity checks.
  // Reuse those encodings; metadata is encoded separately, never interpolated as raw text.
  const head = JSON.stringify(summary).slice(0, -1);
  return serializedJson(
    `{"run":${head},"scenario":${scenarioJson},"result":${resultJson}}}`,
    status,
  );
}

function cookieName(url: URL): string {
  return url.protocol === 'https:' ? '__Host-irl_session' : 'irl_session';
}

function sessionToken(request: Request, url: URL): string | undefined {
  const prefix = `${cookieName(url)}=`;
  const matching =
    request.headers
      .get('Cookie')
      ?.split(';')
      .map((s) => s.trim())
      .filter((s) => s.startsWith(prefix)) ?? [];
  const value = matching.length === 1 ? matching[0].slice(prefix.length) : undefined;
  return value && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
}

function ownerId(token: string): Promise<string> {
  return sha256(new TextEncoder().encode(token));
}

async function verifyStoredResult(
  stored: string,
  resultJson: string,
  engineVersion: string,
): Promise<void> {
  // Earlier records stored the complete canonical result. Keep those readable
  // without parsing a second large object or rewriting historical data on read.
  if (stored === resultJson) return;
  if (stored.length > MAX_DIGEST_ENVELOPE_LENGTH)
    throw new Error('Saved result integrity check failed');
  const parsed: unknown = JSON.parse(stored);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid saved result digest');
  }
  const envelope = parsed as Record<string, unknown>;
  if (
    Object.keys(envelope).length !== 4 ||
    envelope.format !== RESULT_DIGEST_FORMAT ||
    envelope.schemaVersion !== 1 ||
    envelope.engineVersion !== engineVersion ||
    typeof envelope.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(envelope.sha256)
  ) {
    throw new Error('Invalid or unsupported saved result digest');
  }
  if (envelope.sha256 !== (await sha256(new TextEncoder().encode(resultJson)))) {
    throw new Error('Saved result integrity check failed');
  }
}

function requireSameOrigin(request: Request, url: URL): void {
  if (
    request.headers.get('Origin') !== url.origin ||
    request.headers.get('Sec-Fetch-Site') === 'cross-site'
  ) {
    throw new HttpError(403, 'This request must come from the application on this origin.');
  }
  if (
    request.method === 'POST' &&
    request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json'
  ) {
    throw new HttpError(415, 'Use an application/json request.');
  }
}

async function readBoundedJson(
  request: Request,
  limit = MAX_SCENARIO_BYTES + 1_024,
): Promise<unknown> {
  const tooLarge = () =>
    new HttpError(
      413,
      limit === 1_024
        ? 'Session request exceeds the 1 KiB limit.'
        : 'Scenario exceeds the 64 KiB limit.',
    );
  if (Number(request.headers.get('Content-Length')) > limit) throw tooLarge();
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'A JSON request body is required.');
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        throw new HttpError(400, 'The request body could not be read.');
      }
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) {
        try {
          await reader.cancel();
        } catch {
          /* Cancellation failure must not replace the size-limit response. */
        }
        throw tooLarge();
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new HttpError(400, 'The request is not valid UTF-8 JSON.');
  }
}

async function api(request: Request, env: Env, url: URL): Promise<Response> {
  const now = Date.now();
  const method = request.method;
  const path = url.pathname;
  const id = path.startsWith('/api/runs/') ? path.slice('/api/runs/'.length) : '';
  const allowedMethods =
    path === '/api/health'
      ? ['GET']
      : path === '/api/session' || path === '/api/runs'
        ? ['GET', 'POST']
        : uuid.test(id)
          ? ['GET', 'DELETE']
          : undefined;
  if (!allowedMethods) throw new HttpError(404, 'Run or endpoint not found.');
  if (!allowedMethods.includes(method)) {
    throw new HttpError(405, 'Method not supported.', { Allow: allowedMethods.join(', ') });
  }

  if (path === '/api/health') {
    const ready = await env.DB.prepare('SELECT id, run_count FROM capacity WHERE id = 1').first<{
      id: number;
      run_count: number;
    }>();
    if (
      !ready ||
      !Number.isInteger(ready.run_count) ||
      ready.run_count < 0 ||
      ready.run_count > MAX_TOTAL_RUNS
    ) {
      throw new Error('Database schema is not ready');
    }
    return json({ ok: true, version: env.APP_VERSION ?? '1.0.0' });
  }

  if (method !== 'GET') {
    requireSameOrigin(request, url);
    // Cloudflare supplies this header in production. The limiter is best-effort per location.
    const result = await env.WRITE_LIMITER.limit({
      key: request.headers.get('CF-Connecting-IP') ?? 'local',
    });
    if (!result.success)
      throw new HttpError(429, 'Too many changes. Wait one minute and try again.');
  }

  let token = sessionToken(request, url);
  if (path === '/api/session') {
    if (method === 'POST') {
      const body = await readBoundedJson(request, 1_024);
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) {
        throw new HttpError(400, 'Expected an empty JSON object for session creation.');
      }
    }
    if (!token && method === 'GET') throw new HttpError(401, 'Create a browser workspace first.');
    if (!token) {
      token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
        b.toString(16).padStart(2, '0'),
      ).join('');
    }
    return json({ retentionDays: RETENTION_DAYS, maxRuns: MAX_RUNS }, 200, {
      'Set-Cookie': `${cookieName(url)}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${RETENTION_DAYS * 86400}${url.protocol === 'https:' ? '; Secure' : ''}`,
    });
  }
  if (!token)
    throw new HttpError(401, 'Your browser workspace is unavailable. Reload to create a new one.');
  const owner = await ownerId(token);

  if (path === '/api/runs' && method === 'GET') {
    const rows = await env.DB.prepare(
      'SELECT id, title, origin, created_at, event_count FROM runs WHERE owner_id = ? AND expires_at > ? ORDER BY created_at DESC, id DESC LIMIT 20',
    )
      .bind(owner, now)
      .all<RunRow>();
    return json({ runs: rows.results.map(metadata) });
  }
  if (path === '/api/runs' && method === 'POST') {
    const body = await readBoundedJson(request);
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).join(',') !== 'scenario'
    ) {
      throw new HttpError(400, 'Expected a JSON object containing only scenario.');
    }
    const input = (body as { scenario: unknown }).scenario;
    if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
      const candidate = input as Record<string, unknown>;
      if (
        (Array.isArray(candidate.events) && candidate.events.length > MAX_SAVED_EVENTS) ||
        (Array.isArray(candidate.deliveries) && candidate.deliveries.length > MAX_SAVED_DELIVERIES)
      ) {
        throw new HttpError(
          413,
          `Saved replays support at most ${MAX_SAVED_EVENTS} snapshots and ${MAX_SAVED_DELIVERIES} deliveries. Run larger scenarios locally.`,
        );
      }
    }
    let computed;
    try {
      computed = createReplay(input);
    } catch (error) {
      if (!(error instanceof ScenarioValidationError)) throw error;
      throw new HttpError(error instanceof ScenarioSizeError ? 413 : 400, error.message);
    }
    const { scenario, result: replay } = computed;
    const serialized = JSON.stringify(scenario);
    if (new TextEncoder().encode(serialized).byteLength > MAX_SCENARIO_BYTES)
      throw new HttpError(413, 'Scenario exceeds the 64 KiB limit.');
    const resultJson = JSON.stringify(replay);
    const resultBytes = new TextEncoder().encode(resultJson);
    if (resultBytes.byteLength > MAX_RESULT_BYTES)
      throw new HttpError(
        413,
        'Replay output exceeds the 512 KiB response limit. Use a smaller scenario.',
      );
    const storedResult = JSON.stringify({
      format: RESULT_DIGEST_FORMAT,
      schemaVersion: 1,
      engineVersion: replay.engineVersion,
      sha256: await sha256(resultBytes),
    });
    const runId = crypto.randomUUID();
    const count = scenario.events.length;
    // One statement serializes concurrent capacity checks with the insertion.
    const result = await env.DB.prepare(
      `INSERT INTO runs (id, owner_id, title, origin, created_at, expires_at, event_count, scenario, result)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE (SELECT run_count FROM capacity WHERE id = 1) BETWEEN 0 AND ?
      AND (SELECT COUNT(*) FROM runs WHERE owner_id = ? AND expires_at > ?) < ?`,
    )
      .bind(
        runId,
        owner,
        scenario.title,
        scenario.origin,
        now,
        now + RETENTION_DAYS * DAY,
        count,
        serialized,
        storedResult,
        MAX_TOTAL_RUNS - 1,
        owner,
        now,
        MAX_RUNS,
      )
      .run();
    if (!result.meta.changes)
      throw new HttpError(
        409,
        'Storage limit reached. Export and delete older runs, or run a local replay.',
      );
    return runResponse(
      {
        id: runId,
        title: scenario.title,
        origin: scenario.origin,
        createdAt: new Date(now).toISOString(),
        eventCount: count,
      },
      serialized,
      resultJson,
      201,
    );
  }

  if (method === 'GET') {
    const row = await env.DB.prepare(
      'SELECT id, title, origin, created_at, event_count, scenario, result FROM runs WHERE id = ? AND owner_id = ? AND expires_at > ?',
    )
      .bind(id, owner, now)
      .first<RunRow>();
    if (!row) throw new HttpError(404, 'Run not found in this browser workspace.');
    const summary = metadata(row);
    if (typeof row.scenario !== 'string' || typeof row.result !== 'string')
      throw new Error('Invalid saved run');
    const { scenario, result } = createReplay(JSON.parse(row.scenario));
    const resultJson = JSON.stringify(result);
    // A digest or legacy full result must match this engine's canonical output.
    // Unknown engine versions require an explicit compatibility or migration decision.
    if (
      row.title !== scenario.title ||
      row.origin !== scenario.origin ||
      row.event_count !== scenario.events.length
    )
      throw new Error('Saved run integrity check failed');
    await verifyStoredResult(row.result, resultJson, result.engineVersion);
    return runResponse(summary, JSON.stringify(scenario), resultJson);
  }
  const result = await env.DB.prepare(
    'DELETE FROM runs WHERE id = ? AND owner_id = ? AND expires_at > ?',
  )
    .bind(id, owner, now)
    .run();
  if (!result.meta.changes) throw new HttpError(404, 'Run not found in this browser workspace.');
  return json({ ok: true });
}

interface RunRow {
  id: string;
  title: string;
  origin: string;
  created_at: number;
  event_count: number;
  scenario?: string;
  result?: string;
}
function metadata(row: RunRow) {
  if (
    typeof row.id !== 'string' ||
    !uuid.test(row.id) ||
    typeof row.title !== 'string' ||
    !row.title.trim() ||
    row.title.length > 160 ||
    !['fixture', 'imported'].includes(row.origin) ||
    !Number.isSafeInteger(row.created_at) ||
    row.created_at < 0 ||
    row.created_at > 8_640_000_000_000_000 ||
    !Number.isInteger(row.event_count) ||
    row.event_count < 1 ||
    row.event_count > MAX_EVENTS
  ) {
    throw new Error('Invalid saved run metadata');
  }
  return {
    id: row.id,
    title: row.title,
    origin: row.origin,
    createdAt: new Date(row.created_at).toISOString(),
    eventCount: row.event_count,
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    const requestId = crypto.randomUUID();
    let response: Response;
    try {
      response = await api(request, env, url);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 503;
      if (status === 503)
        console.error(
          JSON.stringify({
            event: 'api_unavailable',
            requestId,
            errorType: error instanceof Error ? error.name : 'Unknown',
          }),
        );
      response = json(
        {
          error:
            error instanceof HttpError
              ? error.message
              : 'Saved runs are temporarily unavailable. You can still replay and export locally.',
          requestId,
        },
        status,
        {
          ...(error instanceof HttpError ? error.headers : {}),
          ...(status === 429 ? { 'Retry-After': '60' } : {}),
        },
      );
    }
    response.headers.set('X-Request-ID', requestId);
    if (url.protocol === 'https:')
      response.headers.set('Strict-Transport-Security', 'max-age=31536000');
    return response;
  },
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const result = await env.DB.prepare('DELETE FROM runs WHERE expires_at <= ?')
      .bind(Date.now())
      .run();
    // D1 includes counter-trigger updates in changes, not just deleted runs.
    console.log(
      JSON.stringify({
        event: 'retention_cleanup_completed',
        databaseChanges: result.meta.changes,
      }),
    );
  },
};
