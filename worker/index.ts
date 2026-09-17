import { parseScenario, MAX_SCENARIO_BYTES } from '../src/core/schema';
import { replayScenario } from '../src/core/replay';

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  WRITE_LIMITER: { limit(options: { key: string }): Promise<{ success: boolean }> };
  APP_VERSION?: string;
}

const DAY = 86_400_000;
const MAX_RUNS = 20;
const MAX_TOTAL_RUNS = 500;
const RETENTION_DAYS = 30;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function json(data: unknown, status = 200, extra: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
      ...extra,
    },
  });
}

function cookieName(url: URL): string {
  return url.protocol === 'https:' ? '__Host-irl_session' : 'irl_session';
}

function sessionToken(request: Request, url: URL): string | undefined {
  const prefix = `${cookieName(url)}=`;
  const matching = request.headers.get('Cookie')?.split(';').map(s => s.trim()).filter(s => s.startsWith(prefix)) ?? [];
  const value = matching.length === 1 ? matching[0].slice(prefix.length) : undefined;
  return value && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
}

async function ownerId(token: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}

function requireSameOrigin(request: Request, url: URL): void {
  if (request.headers.get('Origin') !== url.origin || request.headers.get('Sec-Fetch-Site') === 'cross-site') {
    throw new HttpError(403, 'This request must come from the application on this origin.');
  }
  if (request.method === 'POST' && request.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/json') {
    throw new HttpError(415, 'Use an application/json request.');
  }
}

async function readBoundedJson(request: Request): Promise<unknown> {
  const limit = MAX_SCENARIO_BYTES + 1_024;
  if (Number(request.headers.get('Content-Length')) > limit) throw new HttpError(413, 'Scenario exceeds the 64 KiB limit.');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'A JSON request body is required.');
  let size = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw new HttpError(413, 'Scenario exceeds the 64 KiB limit.'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new HttpError(400, 'The request is not valid UTF-8 JSON.'); }
}

async function api(request: Request, env: Env, url: URL): Promise<Response> {
  const now = Date.now();
  const method = request.method;
  const path = url.pathname;
  if (!['GET', 'POST', 'DELETE'].includes(method)) throw new HttpError(405, 'Method not supported.');

  if (path === '/api/health' && method === 'GET') {
    const ready = await env.DB.prepare('SELECT id FROM capacity WHERE id = 1').first();
    if (!ready) throw new Error('Database schema is not ready');
    return json({ ok: true, version: env.APP_VERSION ?? '1.0.0' });
  }

  if (method !== 'GET') {
    requireSameOrigin(request, url);
    // Cloudflare supplies this header in production. The limiter is best-effort per location.
    const result = await env.WRITE_LIMITER.limit({ key: request.headers.get('CF-Connecting-IP') ?? 'local' });
    if (!result.success) throw new HttpError(429, 'Too many changes. Wait one minute and try again.');
  }

  let token = sessionToken(request, url);
  if (path === '/api/session') {
    if (!['GET', 'POST'].includes(method)) throw new HttpError(405, 'Method not supported.');
    if (!token && method === 'GET') throw new HttpError(401, 'Create a browser workspace first.');
    if (!token) {
      token = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
    }
    return json({ retentionDays: RETENTION_DAYS, maxRuns: MAX_RUNS }, 200, {
      'Set-Cookie': `${cookieName(url)}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${RETENTION_DAYS * 86400}${url.protocol === 'https:' ? '; Secure' : ''}`,
    });
  }
  if (!token) throw new HttpError(401, 'Your browser workspace is unavailable. Reload to create a new one.');
  const owner = await ownerId(token);

  if (path === '/api/runs' && method === 'GET') {
    const rows = await env.DB.prepare('SELECT id, title, origin, created_at, event_count FROM runs WHERE owner_id = ? AND expires_at > ? ORDER BY created_at DESC, id DESC LIMIT 20').bind(owner, now).all<RunRow>();
    return json({ runs: rows.results.map(metadata) });
  }
  if (path === '/api/runs' && method === 'POST') {
    const body = await readBoundedJson(request);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).join(',') !== 'scenario') {
      throw new HttpError(400, 'Expected a JSON object containing only scenario.');
    }
    let scenario;
    try { scenario = parseScenario((body as { scenario: unknown }).scenario); }
    catch (error) { throw new HttpError(400, error instanceof Error ? error.message : 'Invalid scenario.'); }
    const serialized = JSON.stringify(scenario);
    if (new TextEncoder().encode(serialized).byteLength > MAX_SCENARIO_BYTES) throw new HttpError(413, 'Scenario exceeds the 64 KiB limit.');
    const id = crypto.randomUUID();
    const count = scenario.events.length;
    const replay = replayScenario(scenario);
    const resultJson = JSON.stringify(replay);
    if (new TextEncoder().encode(resultJson).byteLength > 512 * 1024) throw new HttpError(413, 'Replay output exceeds the 512 KiB storage limit. Use a smaller scenario.');
    // One statement serializes concurrent capacity checks with the insertion.
    const result = await env.DB.prepare(`INSERT INTO runs (id, owner_id, title, origin, created_at, expires_at, event_count, scenario, result)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE (SELECT run_count FROM capacity WHERE id = 1) < ?
      AND (SELECT COUNT(*) FROM runs WHERE owner_id = ? AND expires_at > ?) < ?`)
      .bind(id, owner, scenario.title, scenario.origin, now, now + RETENTION_DAYS * DAY, count, serialized, resultJson, MAX_TOTAL_RUNS, owner, now, MAX_RUNS).run();
    if (!result.meta.changes) throw new HttpError(409, 'Storage limit reached. Export and delete older runs, or run a local replay.');
    return json({ run: { id, title: scenario.title, origin: scenario.origin, createdAt: new Date(now).toISOString(), eventCount: count, scenario, result: replay } }, 201);
  }

  const id = path.startsWith('/api/runs/') ? path.slice('/api/runs/'.length) : '';
  if (!uuid.test(id)) throw new HttpError(404, 'Run or endpoint not found.');
  if (method === 'GET') {
    const row = await env.DB.prepare('SELECT id, title, origin, created_at, event_count, scenario, result FROM runs WHERE id = ? AND owner_id = ? AND expires_at > ?').bind(id, owner, now).first<RunRow>();
    if (!row) throw new HttpError(404, 'Run not found in this browser workspace.');
    return json({ run: { ...metadata(row), scenario: JSON.parse(row.scenario!), result: JSON.parse(row.result!) } });
  }
  if (method === 'DELETE') {
    const result = await env.DB.prepare('DELETE FROM runs WHERE id = ? AND owner_id = ? AND expires_at > ?').bind(id, owner, now).run();
    if (!result.meta.changes) throw new HttpError(404, 'Run not found in this browser workspace.');
    return json({ ok: true });
  }
  throw new HttpError(405, 'Method not supported.');
}

interface RunRow { id: string; title: string; origin: string; created_at: number; event_count: number; scenario?: string; result?: string }
function metadata(row: RunRow) {
  return { id: row.id, title: row.title, origin: row.origin, createdAt: new Date(row.created_at).toISOString(), eventCount: row.event_count };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    const requestId = crypto.randomUUID();
    try {
      const response = await api(request, env, url);
      response.headers.set('X-Request-ID', requestId);
      return response;
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 503;
      if (status === 503) console.error(JSON.stringify({ event: 'api_unavailable', requestId, errorType: error instanceof Error ? error.name : 'Unknown' }));
      return json({ error: error instanceof HttpError ? error.message : 'Saved runs are temporarily unavailable. You can still replay and export locally.', requestId }, status, {
        'X-Request-ID': requestId,
        ...(status === 429 ? { 'Retry-After': '60' } : {}),
      });
    }
  },
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const result = await env.DB.prepare('DELETE FROM runs WHERE expires_at <= ?').bind(Date.now()).run();
    console.log(JSON.stringify({ event: 'expired_runs_deleted', count: result.meta.changes }));
  },
};
