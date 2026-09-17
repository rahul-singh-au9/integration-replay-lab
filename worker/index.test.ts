import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker, { type Env } from './index';
import { fixtures } from '../src/core/fixtures';
import { replayScenario } from '../src/core/replay';

const origin = 'https://lab.example';
let db: DatabaseSync;
let env: Env;
let limitSuccess = true;

function adapter(): D1Database {
  return {
    prepare(sql: string) {
      let args: (string | number | null)[] = [];
      const statement = {
        bind(...values: (string | number | null)[]) { args = values; return statement; },
        async first() { return db.prepare(sql).get(...args) ?? null; },
        async all() { return { results: db.prepare(sql).all(...args) }; },
        async run() { return { meta: { changes: Number(db.prepare(sql).run(...args).changes) } }; },
      };
      return statement;
    },
  } as unknown as D1Database;
}

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../migrations/0001_runs.sql', import.meta.url), 'utf8'));
  limitSuccess = true;
  env = { DB: adapter(), ASSETS: { fetch: async () => new Response('asset') } as unknown as Fetcher,
    WRITE_LIMITER: { limit: async () => ({ success: limitSuccess }) } };
});
afterEach(() => { db.close(); vi.restoreAllMocks(); });

async function request(path: string, method = 'GET', cookie?: string, body?: unknown, overrides?: Record<string,string>) {
  return worker.fetch(new Request(`${origin}${path}`, { method, headers: {
    Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...overrides,
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
}
async function session(): Promise<string> {
  const response = await request('/api/session', 'POST', undefined, {});
  return response.headers.get('Set-Cookie')!.split(';')[0];
}
async function save(cookie: string) {
  return request('/api/runs', 'POST', cookie, { scenario: fixtures[0].scenario });
}

describe('private run API', () => {
  it('uses secure HttpOnly same-site cookies and never returns the credential in JSON', async () => {
    const response = await request('/api/session', 'POST', undefined, {});
    const setCookie = response.headers.get('Set-Cookie')!;
    expect(setCookie).toContain('__Host-irl_session=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Strict');
    expect(await response.json()).toEqual({ retentionDays: 30, maxRuns: 20 });
  });

  it('requires sessions, validates cookies, and refuses cross-origin changes', async () => {
    expect((await request('/api/runs')).status).toBe(401);
    expect((await request('/api/session', 'GET', '__Host-irl_session=short')).status).toBe(401);
    expect((await request('/api/session', 'POST', undefined, {}, { Origin: 'https://elsewhere.example' })).status).toBe(403);
    expect((await request('/api/session', 'POST', undefined, {}, { 'Content-Type': 'text/plain' })).status).toBe(415);
  });

  it.each([
    ['missing Origin', {}],
    ['cross-site fetch metadata despite a matching Origin', { Origin: origin, 'Sec-Fetch-Site': 'cross-site' }],
  ])('rejects run writes with %s without changing stored data', async (_description, extraHeaders) => {
    const cookie = await session();
    const { run } = await (await save(cookie)).json() as { run: { id: string } };
    const headers = new Headers({ Cookie: cookie, 'Content-Type': 'application/json' });
    for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, value);

    const create = await worker.fetch(new Request(`${origin}/api/runs`, {
      method: 'POST', headers, body: JSON.stringify({ scenario: fixtures[0].scenario }),
    }), env);
    const remove = await worker.fetch(new Request(`${origin}/api/runs/${run.id}`, {
      method: 'DELETE', headers,
    }), env);

    expect(create.status).toBe(403);
    expect(remove.status).toBe(403);
    expect(db.prepare('SELECT COUNT(*) AS n FROM runs').get()?.n).toBe(1);
    expect((await request(`/api/runs/${run.id}`, 'GET', cookie)).status).toBe(200);
  });

  it('rejects ambiguous duplicate session cookies instead of selecting either owner', async () => {
    const alice = await session();
    const bob = await session();
    const { run } = await (await save(alice)).json() as { run: { id: string } };

    for (const cookie of [`${alice}; ${bob}`, `${bob}; ${alice}`, `${alice}; ${alice}`]) {
      expect((await request('/api/session', 'GET', cookie)).status).toBe(401);
      expect((await request('/api/runs', 'GET', cookie)).status).toBe(401);
      expect((await request(`/api/runs/${run.id}`, 'GET', cookie)).status).toBe(401);
      expect((await request(`/api/runs/${run.id}`, 'DELETE', cookie)).status).toBe(401);
      expect((await save(cookie)).status).toBe(401);
    }

    expect(db.prepare('SELECT COUNT(*) AS n FROM runs').get()?.n).toBe(1);
    expect((await request(`/api/runs/${run.id}`, 'GET', alice)).status).toBe(200);
  });

  it('persists an exact validated scenario, lists it, and isolates reads and deletes by owner', async () => {
    const alice = await session();
    const bob = await session();
    const response = await save(alice);
    expect(response.status).toBe(201);
    const { run } = await response.json() as { run: { id:string; scenario:unknown; result:unknown } };
    expect(run.scenario).toEqual(fixtures[0].scenario);
    expect(run.result).toEqual(replayScenario(fixtures[0].scenario));
    expect((await request(`/api/runs/${run.id}`, 'GET', bob)).status).toBe(404);
    expect((await request(`/api/runs/${run.id}`, 'DELETE', bob)).status).toBe(404);
    const list = await (await request('/api/runs', 'GET', alice)).json() as {runs:unknown[]};
    expect(list.runs).toHaveLength(1);
    const stored = await request(`/api/runs/${run.id}`, 'GET', alice);
    expect(stored.status).toBe(200);
    expect((await stored.json() as {run:{result:unknown}}).run.result).toEqual(run.result);
    expect((await request(`/api/runs/${run.id}`, 'DELETE', alice)).status).toBe(200);
    expect((await request(`/api/runs/${run.id}`, 'GET', alice)).status).toBe(404);
    expect(db.prepare('SELECT run_count FROM capacity').get()?.run_count).toBe(0);
  });

  it('rejects malformed data, oversized payloads, and unsupported paths without storing data', async () => {
    const cookie = await session();
    expect((await request('/api/runs', 'POST', cookie, {scenario:{events:[]}})).status).toBe(400);
    expect((await request('/api/runs', 'POST', cookie, {scenario:fixtures[0].scenario, owner_id:'someone'})).status).toBe(400);
    expect((await request('/api/runs', 'POST', cookie, {scenario:fixtures[0].scenario, result:{allPassed:true}})).status).toBe(400);
    expect((await request('/api/runs', 'POST', cookie, {scenario:'x'.repeat(70_000)})).status).toBe(413);
    expect((await request('/api/runs/not-an-id', 'GET', cookie)).status).toBe(404);
    expect(db.prepare('SELECT COUNT(*) AS n FROM runs').get()?.n).toBe(0);
  });

  it('cancels an oversized multibyte body stream without relying on Content-Length', async () => {
    const cookie = await session();
    const text = JSON.stringify({ scenario: '界'.repeat(30_000) });
    const bytes = new TextEncoder().encode(text);
    expect(text.length).toBeLessThan(64 * 1024);
    expect(bytes.byteLength).toBeGreaterThan(64 * 1024);
    let offset = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === bytes.length) { controller.close(); return; }
        const end = Math.min(offset + 4096, bytes.length);
        controller.enqueue(bytes.slice(offset, end));
        offset = end;
      },
      cancel() { cancelled = true; },
    });
    const init: RequestInit & { duplex: 'half' } = {
      method: 'POST',
      headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
      body,
      duplex: 'half',
    };
    const incoming = new Request(`${origin}/api/runs`, init);
    expect(incoming.headers.has('Content-Length')).toBe(false);

    const response = await worker.fetch(incoming, env);

    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(offset).toBeLessThan(bytes.length);
    expect(db.prepare('SELECT COUNT(*) AS n FROM runs').get()?.n).toBe(0);
  });

  it('rejects malformed UTF-8 rather than replacing corrupt bytes before validation', async () => {
    const cookie = await session();
    const encoder = new TextEncoder();
    const bytes = new Uint8Array([
      ...encoder.encode('{"scenario":"'),
      0xc3, 0x28,
      ...encoder.encode('"}'),
    ]);
    const response = await worker.fetch(new Request(`${origin}/api/runs`, {
      method: 'POST',
      headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
      body: bytes,
    }), env);

    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toContain('UTF-8');
    expect(db.prepare('SELECT COUNT(*) AS n FROM runs').get()?.n).toBe(0);
  });

  it('caps each workspace atomically, including concurrent saves', async () => {
    const cookie = await session();
    const responses = await Promise.all(Array.from({length:25}, () => save(cookie)));
    expect(responses.filter(r => r.status === 201)).toHaveLength(20);
    expect(responses.filter(r => r.status === 409)).toHaveLength(5);
    expect(db.prepare('SELECT run_count FROM capacity').get()?.run_count).toBe(20);
  });

  it('admits only one concurrent owner at the global boundary and releases capacity on deletion', async () => {
    const now = Date.now();
    const scenario = fixtures[0].scenario;
    const insert = db.prepare(`INSERT INTO runs
      (id, owner_id, title, origin, created_at, expires_at, event_count, scenario, result)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const replay = JSON.stringify(replayScenario(scenario));
    db.exec('BEGIN');
    for (let index = 0; index < 499; index++) {
      insert.run(crypto.randomUUID(), `seed-owner-${Math.floor(index / 20)}`, scenario.title,
        scenario.origin, now, now + 30 * 86_400_000, 1, JSON.stringify(scenario), replay);
    }
    db.exec('COMMIT');
    expect(db.prepare('SELECT COUNT(*) AS n FROM runs').get()?.n).toBe(499);
    expect(db.prepare('SELECT run_count FROM capacity').get()?.run_count).toBe(499);

    const cookies = await Promise.all(Array.from({ length: 8 }, () => session()));
    const responses = await Promise.all(cookies.map(cookie => save(cookie)));
    expect(responses.filter(response => response.status === 201)).toHaveLength(1);
    expect(responses.filter(response => response.status === 409)).toHaveLength(7);
    expect(db.prepare('SELECT COUNT(*) AS n FROM runs').get()?.n).toBe(500);
    expect(db.prepare('SELECT run_count FROM capacity').get()?.run_count).toBe(500);
    expect(db.prepare('SELECT owner_id FROM runs GROUP BY owner_id HAVING COUNT(*) > 20').all()).toEqual([]);

    const winner = responses.findIndex(response => response.status === 201);
    const loser = responses.findIndex(response => response.status === 409);
    const { run } = await responses[winner].json() as { run: { id: string } };
    const losingList = await (await request('/api/runs', 'GET', cookies[loser])).json() as { runs: unknown[] };
    expect(losingList.runs).toHaveLength(0);
    expect((await request(`/api/runs/${run.id}`, 'DELETE', cookies[winner])).status).toBe(200);
    expect(db.prepare('SELECT run_count FROM capacity').get()?.run_count).toBe(499);
    expect((await save(cookies[loser])).status).toBe(201);
    expect(db.prepare('SELECT COUNT(*) AS n FROM runs').get()?.n).toBe(500);
    expect(db.prepare('SELECT run_count FROM capacity').get()?.run_count).toBe(500);
  });

  it('stops access exactly at expiration before scheduled cleanup removes the row', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-17T10:00:00Z'));
    const cookie = await session();
    const {run} = await (await save(cookie)).json() as {run:{id:string}};
    const row = db.prepare('SELECT expires_at FROM runs WHERE id = ?').get(run.id)!;
    const expiresAt = Number(row.expires_at);
    expect(expiresAt - Date.now()).toBe(30 * 86_400_000);
    clock.mockReturnValue(expiresAt - 1);
    expect((await request(`/api/runs/${run.id}`, 'GET', cookie)).status).toBe(200);
    const before = await (await request('/api/runs', 'GET', cookie)).json() as { runs: unknown[] };
    expect(before.runs).toHaveLength(1);

    clock.mockReturnValue(expiresAt);
    expect((await request(`/api/runs/${run.id}`, 'GET', cookie)).status).toBe(404);
    const list = await (await request('/api/runs', 'GET', cookie)).json() as {runs:unknown[]};
    expect(list.runs).toHaveLength(0);
    expect((await request(`/api/runs/${run.id}`, 'DELETE', cookie)).status).toBe(404);
    expect(db.prepare('SELECT COUNT(*) AS n FROM runs').get()?.n).toBe(1);
    await worker.scheduled({} as ScheduledController, env);
    expect(db.prepare('SELECT COUNT(*) AS n FROM runs').get()?.n).toBe(0);
    expect(db.prepare('SELECT run_count FROM capacity').get()?.run_count).toBe(0);
  });

  it('reports an unhealthy database when the required capacity record is absent', async () => {
    expect((await request('/api/health')).status).toBe(200);
    db.exec('DELETE FROM capacity WHERE id = 1');
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await request('/api/health');

    expect(response.status).toBe(503);
    const body = await response.json() as { ok?: boolean; error: string; requestId: string };
    expect(body.ok).not.toBe(true);
    expect(body.error).not.toContain('schema');
    expect(body.requestId).toBe(response.headers.get('X-Request-ID'));
  });

  it('returns rate-limit retry guidance and fails closed when the limiter or database is unavailable', async () => {
    const cookie = await session();
    limitSuccess = false;
    const limited = await save(cookie);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('60');
    limitSuccess = true;
    vi.spyOn(env.WRITE_LIMITER, 'limit').mockRejectedValueOnce(new Error('sensitive internal detail'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await save(cookie)).status).toBe(503);
    vi.spyOn(env.DB, 'prepare').mockImplementation(() => { throw new Error('secret connection detail'); });
    const failure = await request('/api/runs', 'GET', cookie);
    expect(failure.status).toBe(503);
    expect(await failure.text()).not.toContain('secret');
    expect((await request('/api/health')).status).toBe(503);
  });
});
