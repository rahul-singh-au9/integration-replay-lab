import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import worker, { type Env } from './index';
import { fixtures } from '../src/core/fixtures';
import { replayScenario, type ReplayResult } from '../src/core/replay';
import type { Scenario } from '../src/core/schema';
import * as replayEngine from '../src/core/replay';

interface SavedRunResponse {
  run: { id: string; scenario: Scenario; result: ReplayResult };
}
const origin = 'https://lab.example';
let db: DatabaseSync;
let env: Env;
let limitSuccess = true;

function adapter(): D1Database {
  return {
    prepare(sql: string) {
      let args: (string | number | null)[] = [];
      const statement = {
        bind(...values: (string | number | null)[]) {
          args = values;
          return statement;
        },
        first() {
          return Promise.resolve(db.prepare(sql).get(...args) ?? null);
        },
        all() {
          return Promise.resolve({ results: db.prepare(sql).all(...args) });
        },
        run() {
          return Promise.resolve({
            meta: { changes: Number(db.prepare(sql).run(...args).changes) },
          });
        },
      };
      return statement;
    },
  } as unknown as D1Database;
}

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  for (const file of readdirSync(new URL('../migrations/', import.meta.url))
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    db.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
  }
  limitSuccess = true;
  env = {
    DB: adapter(),
    ASSETS: { fetch: () => Promise.resolve(new Response('asset')) } as unknown as Fetcher,
    WRITE_LIMITER: { limit: () => Promise.resolve({ success: limitSuccess }) },
  };
});
afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

async function request(
  path: string,
  method = 'GET',
  cookie?: string,
  body?: unknown,
  overrides?: Record<string, string>,
) {
  return worker.fetch(
    new Request(`${origin}${path}`, {
      method,
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
        ...overrides,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env,
  );
}
async function session(): Promise<string> {
  const response = await request('/api/session', 'POST', undefined, {});
  return response.headers.get('Set-Cookie')!.split(';')[0];
}
async function save(cookie: string) {
  return request('/api/runs', 'POST', cookie, { scenario: fixtures[0].scenario });
}

describe('private run API', () => {
  it('preserves escaped metadata and complete results when reusing encoded JSON', async () => {
    const cookie = await session();
    const scenario = structuredClone(fixtures[0].scenario);
    scenario.title = 'Quoted "title" \\ newline\n },"injected":true — synthetic';
    const response = await request('/api/runs', 'POST', cookie, { scenario });
    expect(response.status).toBe(201);
    const body = await response.json<{ run: SavedRunResponse['run'] & { title: string } }>();
    expect(Object.keys(body)).toEqual(['run']);
    expect(Object.keys(body.run).sort()).toEqual(
      ['id', 'title', 'origin', 'createdAt', 'eventCount', 'scenario', 'result'].sort(),
    );
    expect(body.run.title).toBe(scenario.title);
    expect(body.run.scenario).toEqual(scenario);
    expect(body.run.result).toEqual(replayScenario(scenario));
    const loaded = await request(`/api/runs/${body.run.id}`, 'GET', cookie);
    expect(loaded.status).toBe(200);
    expect(await loaded.json()).toEqual(body);
  });

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
    expect(
      (
        await request(
          '/api/session',
          'POST',
          undefined,
          {},
          { Origin: 'https://elsewhere.example' },
        )
      ).status,
    ).toBe(403);
    expect(
      (await request('/api/session', 'POST', undefined, {}, { 'Content-Type': 'text/plain' }))
        .status,
    ).toBe(415);
  });

  it.each([
    ['missing Origin', {}],
    [
      'cross-site fetch metadata despite a matching Origin',
      { Origin: origin, 'Sec-Fetch-Site': 'cross-site' },
    ],
  ])(
    'rejects run writes with %s without changing stored data',
    async (_description, extraHeaders) => {
      const cookie = await session();
      const { run } = await (await save(cookie)).json<SavedRunResponse>();
      const headers = new Headers({ Cookie: cookie, 'Content-Type': 'application/json' });
      for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, value);

      const create = await worker.fetch(
        new Request(`${origin}/api/runs`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ scenario: fixtures[0].scenario }),
        }),
        env,
      );
      const remove = await worker.fetch(
        new Request(`${origin}/api/runs/${run.id}`, {
          method: 'DELETE',
          headers,
        }),
        env,
      );

      expect(create.status).toBe(403);
      expect(remove.status).toBe(403);
      expect(db.prepare('SELECT COUNT(*) AS n FROM runs').get()?.n).toBe(1);
      expect((await request(`/api/runs/${run.id}`, 'GET', cookie)).status).toBe(200);
    },
  );

  it('rejects ambiguous duplicate session cookies instead of selecting either owner', async () => {
    const alice = await session();
    const bob = await session();
    const { run } = await (await save(alice)).json<SavedRunResponse>();

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
    const { run } = await response.json<SavedRunResponse>();
    expect(run.scenario).toEqual(fixtures[0].scenario);
    expect(run.result).toEqual(replayScenario(fixtures[0].scenario));
    expect((await request(`/api/runs/${run.id}`, 'GET', bob)).status).toBe(404);
    expect((await request(`/api/runs/${run.id}`, 'DELETE', bob)).status).toBe(404);
    const list = await (await request('/api/runs', 'GET', alice)).json<{ runs: unknown[] }>();
    expect(list.runs).toHaveLength(1);
    const stored = await request(`/api/runs/${run.id}`, 'GET', alice);
    expect(stored.status).toBe(200);
    expect((await stored.json<SavedRunResponse>()).run.result).toEqual(run.result);
    expect((await request(`/api/runs/${run.id}`, 'DELETE', alice)).status).toBe(200);
    expect((await request(`/api/runs/${run.id}`, 'GET', alice)).status).toBe(404);
    expect(db.prepare('SELECT run_count FROM capacity').get()?.run_count).toBe(0);
  });

  it('rejects malformed data, oversized payloads, and unsupported paths without storing data', async () => {
    const cookie = await session();
    expect((await request('/api/runs', 'POST', cookie, { scenario: { events: [] } })).status).toBe(
      400,
    );
    expect(
      (
        await request('/api/runs', 'POST', cookie, {
          scenario: fixtures[0].scenario,
          owner_id: 'someone',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request('/api/runs', 'POST', cookie, {
          scenario: fixtures[0].scenario,
          result: { allPassed: true },
        })
      ).status,
    ).toBe(400);
    expect(
      (await request('/api/runs', 'POST', cookie, { scenario: 'x'.repeat(70_000) })).status,
    ).toBe(413);
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
        if (offset === bytes.length) {
          controller.close();
          return;
        }
        const end = Math.min(offset + 4096, bytes.length);
        controller.enqueue(bytes.slice(offset, end));
        offset = end;
      },
      cancel() {
        cancelled = true;
      },
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
      0xc3,
      0x28,
      ...encoder.encode('"}'),
    ]);
    const response = await worker.fetch(
      new Request(`${origin}/api/runs`, {
        method: 'POST',
        headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
        body: bytes,
      }),
      env,
    );

    expect(response.status).toBe(400);
    expect((await response.json<{ error: string }>()).error).toContain('UTF-8');
    expect(db.prepare('SELECT COUNT(*) AS n FROM runs').get()?.n).toBe(0);
  });

  it('caps each workspace atomically, including concurrent saves', async () => {
    const cookie = await session();
    const responses = await Promise.all(Array.from({ length: 25 }, () => save(cookie)));
    expect(responses.filter((r) => r.status === 201)).toHaveLength(20);
    expect(responses.filter((r) => r.status === 409)).toHaveLength(5);
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
      insert.run(
        crypto.randomUUID(),
        `seed-owner-${Math.floor(index / 20)}`,
        scenario.title,
        scenario.origin,
        now,
        now + 30 * 86_400_000,
        1,
        JSON.stringify(scenario),
        replay,
      );
    }
    db.exec('COMMIT');
    expect(db.prepare('SELECT COUNT(*) AS n FROM runs').get()?.n).toBe(499);
    expect(db.prepare('SELECT run_count FROM capacity').get()?.run_count).toBe(499);

    const cookies = await Promise.all(Array.from({ length: 8 }, () => session()));
    const responses = await Promise.all(cookies.map((cookie) => save(cookie)));
    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 409)).toHaveLength(7);
    expect(db.prepare('SELECT COUNT(*) AS n FROM runs').get()?.n).toBe(500);
    expect(db.prepare('SELECT run_count FROM capacity').get()?.run_count).toBe(500);
    expect(
      db.prepare('SELECT owner_id FROM runs GROUP BY owner_id HAVING COUNT(*) > 20').all(),
    ).toEqual([]);

    const winner = responses.findIndex((response) => response.status === 201);
    const loser = responses.findIndex((response) => response.status === 409);
    const { run } = await responses[winner].json<SavedRunResponse>();
    const losingList = await (
      await request('/api/runs', 'GET', cookies[loser])
    ).json<{ runs: unknown[] }>();
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
    const { run } = await (await save(cookie)).json<SavedRunResponse>();
    const row = db.prepare('SELECT expires_at FROM runs WHERE id = ?').get(run.id)!;
    const expiresAt = Number(row.expires_at);
    expect(expiresAt - Date.now()).toBe(30 * 86_400_000);
    clock.mockReturnValue(expiresAt - 1);
    expect((await request(`/api/runs/${run.id}`, 'GET', cookie)).status).toBe(200);
    const before = await (await request('/api/runs', 'GET', cookie)).json<{ runs: unknown[] }>();
    expect(before.runs).toHaveLength(1);

    clock.mockReturnValue(expiresAt);
    expect((await request(`/api/runs/${run.id}`, 'GET', cookie)).status).toBe(404);
    const list = await (await request('/api/runs', 'GET', cookie)).json<{ runs: unknown[] }>();
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
    const body = await response.json<{ ok?: boolean; error: string; requestId: string }>();
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
    vi.spyOn(env.WRITE_LIMITER, 'limit').mockRejectedValueOnce(
      new Error('sensitive internal detail'),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await save(cookie)).status).toBe(503);
    vi.spyOn(env.DB, 'prepare').mockImplementation(() => {
      throw new Error('secret connection detail');
    });
    const failure = await request('/api/runs', 'GET', cookie);
    expect(failure.status).toBe(503);
    expect(await failure.text()).not.toContain('secret');
    expect((await request('/api/health')).status).toBe(503);
  });
});

describe('API boundary and persisted integrity', () => {
  it.each([
    ['/api/unknown', 'POST', 404, null],
    ['/api/runs/not-an-id', 'GET', 404, null],
    ['/api/runs/', 'DELETE', 404, null],
    ['/api/health', 'POST', 405, 'GET'],
    ['/api/session', 'DELETE', 405, 'GET, POST'],
    ['/api/runs', 'PUT', 405, 'GET, POST'],
    ['/api/runs/9c7a60e3-ad13-42e9-ae07-0f0bece19f36', 'POST', 405, 'GET, DELETE'],
  ])(
    'rejects %s %s before consuming quota or touching storage',
    async (path, method, status, allow) => {
      const limiter = vi.spyOn(env.WRITE_LIMITER, 'limit');
      const storage = vi.spyOn(env.DB, 'prepare');
      const response = await request(path, method);
      expect(response.status).toBe(status);
      expect(response.headers.get('Allow')).toBe(allow);
      expect(limiter).not.toHaveBeenCalled();
      expect(storage).not.toHaveBeenCalled();
    },
  );

  it.each([{}, { cookie: '__Host-irl_session=invalid' }])(
    'keeps successful and failing API responses private with security headers',
    async ({ cookie }) => {
      const responses = [await request('/api/health'), await request('/api/runs', 'GET', cookie)];
      for (const response of responses) {
        expect(response.headers.get('Cache-Control')).toBe('no-store');
        expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
        expect(response.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
        expect(response.headers.get('X-Frame-Options')).toBe('DENY');
        expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
        expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
        expect(response.headers.get('Strict-Transport-Security')).toBe('max-age=31536000');
        expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
        expect(response.headers.get('X-Request-ID')).toMatch(/^[a-f0-9-]{36}$/);
      }
    },
  );

  it('passes static asset requests to the asset binding without initializing a workspace', async () => {
    const assets = vi.spyOn(env.ASSETS, 'fetch');
    const limiter = vi.spyOn(env.WRITE_LIMITER, 'limit');
    const response = await request('/');
    expect(await response.text()).toBe('asset');
    expect(assets).toHaveBeenCalledOnce();
    expect(limiter).not.toHaveBeenCalled();
    expect(response.headers.get('Set-Cookie')).toBeNull();
  });

  it('permits the local development cookie only on HTTP and does not downgrade production cookies', async () => {
    const localOrigin = 'http://localhost:8790';
    const local = await worker.fetch(
      new Request(`${localOrigin}/api/session`, {
        method: 'POST',
        headers: { Origin: localOrigin, 'Content-Type': 'application/json' },
        body: '{}',
      }),
      env,
    );
    expect(local.status).toBe(200);
    const localCookie = local.headers.get('Set-Cookie')!;
    expect(localCookie.startsWith('irl_session=')).toBe(true);
    expect(localCookie).not.toContain('; Secure');
    expect(local.headers.get('Strict-Transport-Security')).toBeNull();
    expect((await request('/api/session', 'GET', localCookie.split(';')[0])).status).toBe(401);
  });

  it('accepts case-insensitive JSON media types and preserves a valid workspace when refreshing', async () => {
    const cookie = await session();
    const response = await request(
      '/api/session',
      'POST',
      cookie,
      {},
      { 'Content-Type': 'Application/JSON; charset=utf-8' },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Set-Cookie')!.split(';')[0]).toBe(cookie);
  });

  it.each([null, [], { owner: 'forged' }, { unexpected: true }, 'text', 1])(
    'requires an empty session JSON object: %j',
    async (body) => {
      const response = await request('/api/session', 'POST', undefined, body);
      expect(response.status).toBe(400);
      expect(response.headers.get('Set-Cookie')).toBeNull();
    },
  );

  it('rejects missing, invalid, or oversized session bodies without setting a cookie', async () => {
    const missing = await request('/api/session', 'POST');
    const oversized = await request('/api/session', 'POST', undefined, { value: 'x'.repeat(1024) });
    const malformed = await worker.fetch(
      new Request(`${origin}/api/session`, {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: '{',
      }),
      env,
    );
    expect(missing.status).toBe(400);
    expect(malformed.status).toBe(400);
    expect(oversized.status).toBe(413);
    for (const response of [missing, malformed, oversized])
      expect(response.headers.get('Set-Cookie')).toBeNull();
  });

  it('enforces the scenario byte limit independently of the request-envelope allowance', async () => {
    const cookie = await session();
    const scenario = { ...fixtures[0].scenario, ignored: '' };
    scenario.ignored = 'x'.repeat(
      65537 - new TextEncoder().encode(JSON.stringify(scenario)).byteLength,
    );
    const body = JSON.stringify({ scenario });
    expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(65536);
    expect(new TextEncoder().encode(body).byteLength).toBeLessThan(65536 + 1024);
    const response = await request('/api/runs', 'POST', cookie, { scenario });
    expect(response.status).toBe(413);
    expect(db.prepare('SELECT COUNT(*) AS n FROM runs').get()?.n).toBe(0);
  });

  it('keeps a size rejection when cancellation of a hostile body stream fails', async () => {
    const cookie = await session();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(66 * 1024));
      },
      cancel() {
        throw new Error('do not expose body cancellation detail');
      },
    });
    const init: RequestInit & { duplex: 'half' } = {
      method: 'POST',
      headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
      body,
      duplex: 'half',
    };
    const response = await worker.fetch(new Request(`${origin}/api/runs`, init), env);
    expect(response.status).toBe(413);
    expect(await response.text()).not.toContain('cancellation');
    expect(db.prepare('SELECT COUNT(*) AS n FROM runs').get()?.n).toBe(0);
  });

  it('treats an interrupted request stream as bad input without exposing its exception', async () => {
    const cookie = await session();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('private stream contents'));
      },
    });
    const init: RequestInit & { duplex: 'half' } = {
      method: 'POST',
      headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
      body,
      duplex: 'half',
    };
    const response = await worker.fetch(new Request(`${origin}/api/runs`, init), env);
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('private stream');
    expect(db.prepare('SELECT COUNT(*) AS n FROM runs').get()?.n).toBe(0);
  });

  it.each([
    ['malformed scenario JSON', 'scenario', '{'],
    ['wrong scenario shape', 'scenario', '{"events":[]}'],
    ['malformed cached result JSON', 'result', '{'],
    ['wrong cached result shape', 'result', '{}'],
  ])(
    'fails closed on %s while allowing owner-scoped deletion',
    async (_description, column, corrupted) => {
      const cookie = await session();
      const { run } = await (await save(cookie)).json<SavedRunResponse>();
      db.prepare(`UPDATE runs SET ${column} = ? WHERE id = ?`).run(corrupted, run.id);
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      const response = await request(`/api/runs/${run.id}`, 'GET', cookie);
      expect(response.status).toBe(503);
      const error = await response.json<{ error: string; requestId: string }>();
      expect(error.error).toContain('temporarily unavailable');
      expect(error.requestId).toBe(response.headers.get('X-Request-ID'));
      const logged: unknown = JSON.parse(String(log.mock.calls[0][0]));
      if (logged === null || typeof logged !== 'object')
        throw new Error('Expected a structured log');
      expect(Object.keys(logged)).toEqual(['event', 'requestId', 'errorType']);
      expect((await request(`/api/runs/${run.id}`, 'DELETE', cookie)).status).toBe(200);
    },
  );

  it.each(['wrong metric', 'wrong decision', 'unknown engine', 'unknown property'])(
    'rejects plausible but unverified cached conclusions: %s',
    async (change) => {
      const cookie = await session();
      const { run } = await (await save(cookie)).json<SavedRunResponse>();
      const result = replayScenario(fixtures[0].scenario);
      if (change === 'wrong metric') result.strategies[0].metrics.applied++;
      if (change === 'wrong decision') result.strategies[0].attempts[0].decision = 'conflict';
      if (change === 'unknown engine') Object.assign(result, { engineVersion: 'future-engine' });
      if (change === 'unknown property') Object.assign(result, { trusted: true });
      db.prepare('UPDATE runs SET result = ? WHERE id = ?').run(JSON.stringify(result), run.id);
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const response = await request(`/api/runs/${run.id}`, 'GET', cookie);
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain('future-engine');
    },
  );

  it('rejects valid metadata that disagrees with the stored scenario', async () => {
    const cookie = await session();
    const { run } = await (await save(cookie)).json<SavedRunResponse>();
    db.prepare('UPDATE runs SET title = ? WHERE id = ?').run('Different experiment', run.id);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await request(`/api/runs/${run.id}`, 'GET', cookie)).status).toBe(503);
  });

  it.each([
    ['blank title', 'title', '   '],
    ['invalid timestamp', 'created_at', -1],
    ['out-of-range timestamp', 'created_at', 8_640_000_000_000_001],
    ['noninteger timestamp', 'created_at', 1.25],
    ['invalid count', 'event_count', 51],
  ])('fails closed on %s in both list and detail', async (_description, column, value) => {
    const cookie = await session();
    const { run } = await (await save(cookie)).json<SavedRunResponse>();
    db.prepare(`UPDATE runs SET ${column} = ? WHERE id = ?`).run(value, run.id);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await request('/api/runs', 'GET', cookie)).status).toBe(503);
    expect((await request(`/api/runs/${run.id}`, 'GET', cookie)).status).toBe(503);
  });

  it('stores only the cookie digest and keeps credentials and scenario contents out of logs', async () => {
    const cookie = await session();
    const { run } = await (await save(cookie)).json<SavedRunResponse>();
    const token = cookie.split('=')[1];
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    const expected = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    const row = db.prepare('SELECT owner_id, scenario, result FROM runs WHERE id = ?').get(run.id)!;
    expect(row.owner_id).toBe(expected);
    expect(JSON.stringify(row)).not.toContain(token);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(env.DB, 'prepare').mockImplementation(() => {
      throw new Error(`${token}: ${fixtures[0].scenario.title}`);
    });
    const response = await request(`/api/runs/${run.id}`, 'GET', cookie);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(token);
    expect(JSON.stringify(log.mock.calls)).not.toContain(token);
    expect(JSON.stringify(log.mock.calls)).not.toContain(fixtures[0].scenario.title);
  });

  it('does not charge GET requests to the mutation limiter', async () => {
    const cookie = await session();
    const { run } = await (await save(cookie)).json<SavedRunResponse>();
    const limiter = vi.spyOn(env.WRITE_LIMITER, 'limit');
    limitSuccess = false;
    for (const path of ['/api/session', '/api/runs', `/api/runs/${run.id}`, '/api/health']) {
      expect((await request(path, 'GET', cookie)).status).toBe(200);
    }
    expect(limiter).not.toHaveBeenCalled();
  });

  it('cleans expired rows while preserving unexpired rows and labels trigger-inclusive counts honestly', async () => {
    const cookie = await session();
    const { run: first } = await (await save(cookie)).json<SavedRunResponse>();
    const { run: second } = await (await save(cookie)).json<SavedRunResponse>();
    db.prepare('UPDATE runs SET expires_at = ? WHERE id = ?').run(Date.now(), first.id);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await worker.scheduled({} as ScheduledController, env);
    expect(db.prepare('SELECT id FROM runs').all()).toEqual([{ id: second.id }]);
    expect(db.prepare('SELECT run_count FROM capacity').get()?.run_count).toBe(1);
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({ event: 'retention_cleanup_completed', databaseChanges: 1 }),
    );
  });

  it('enforces UTF-8 bytes for direct storage updates and inserts, not character count', async () => {
    const cookie = await session();
    const { run } = await (await save(cookie)).json<SavedRunResponse>();
    for (const [column, count] of [
      ['scenario', 30_000],
      ['result', 200_000],
    ] as const) {
      const content = '界'.repeat(count);
      expect(content.length).toBeLessThan(column === 'scenario' ? 65536 : 524288);
      expect(() =>
        db.prepare(`UPDATE runs SET ${column} = ? WHERE id = ?`).run(content, run.id),
      ).toThrow('byte limit');
    }
    const row = db.prepare('SELECT * FROM runs WHERE id = ?').get(run.id)!;
    expect(() =>
      db
        .prepare(
          `INSERT INTO runs (id, owner_id, title, origin, created_at, expires_at, event_count, scenario, result)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          crypto.randomUUID(),
          row.owner_id,
          row.title,
          row.origin,
          row.created_at,
          row.expires_at,
          row.event_count,
          '界'.repeat(30_000),
          row.result,
        ),
    ).toThrow('byte limit');
    expect(db.prepare('SELECT run_count FROM capacity').get()?.run_count).toBe(1);
  });
});

describe('replay computation failure', () => {
  it('does not report an unexpected engine failure as caller input or store a partial run', async () => {
    const cookie = await session();
    vi.spyOn(replayEngine, 'createReplay').mockImplementationOnce(() => {
      throw new Error('private engine details');
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await save(cookie);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('private engine');
    expect(JSON.stringify(log.mock.calls)).not.toContain('private engine');
    expect(db.prepare('SELECT COUNT(*) AS n FROM runs').get()?.n).toBe(0);
  });
});

describe('compact saved result integrity', () => {
  function storedEnvelope(id: string): Record<string, unknown> {
    const row = db.prepare('SELECT result FROM runs WHERE id = ?').get(id);
    const parsed: unknown = JSON.parse(String(row?.result));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Expected a stored result envelope');
    }
    return parsed as Record<string, unknown>;
  }

  it('stores a versioned SHA-256 digest while returning the complete deterministic result', async () => {
    const cookie = await session();
    const response = await save(cookie);
    expect(response.status).toBe(201);
    const { run } = await response.json<SavedRunResponse>();
    const canonical = JSON.stringify(replayScenario(run.scenario));
    const digest = createHash('sha256').update(canonical, 'utf8').digest('hex');
    const row = db.prepare('SELECT scenario, result FROM runs WHERE id = ?').get(run.id)!;
    expect(row.scenario).toBe(JSON.stringify(run.scenario));
    expect(storedEnvelope(run.id)).toEqual({
      format: 'integration-replay-result-digest',
      schemaVersion: 1,
      engineVersion: '1.0.0',
      sha256: digest,
    });
    expect(new TextEncoder().encode(String(row.result)).byteLength).toBe(163);
    expect(String(row.result)).not.toContain('strategies');
    expect(JSON.stringify(run.result)).toBe(canonical);
    const fetched = await request(`/api/runs/${run.id}`, 'GET', cookie);
    expect(fetched.status).toBe(200);
    const restored = await fetched.json<SavedRunResponse>();
    expect(restored.run).toEqual(run);
    expect(restored.run.result).not.toHaveProperty('sha256');
  });

  it.each([
    [
      'unknown marker',
      (value: Record<string, unknown>) => {
        value.format = 'unrecognized';
      },
    ],
    [
      'unknown envelope version',
      (value: Record<string, unknown>) => {
        value.schemaVersion = 2;
      },
    ],
    [
      'wrong envelope version type',
      (value: Record<string, unknown>) => {
        value.schemaVersion = '1';
      },
    ],
    [
      'unknown engine version',
      (value: Record<string, unknown>) => {
        value.engineVersion = '2.0.0';
      },
    ],
    [
      'wrong digest type',
      (value: Record<string, unknown>) => {
        value.sha256 = 123;
      },
    ],
    [
      'short digest',
      (value: Record<string, unknown>) => {
        value.sha256 = 'a'.repeat(63);
      },
    ],
    [
      'nonhex digest',
      (value: Record<string, unknown>) => {
        value.sha256 = 'g'.repeat(64);
      },
    ],
    [
      'noncanonical uppercase digest',
      (value: Record<string, unknown>) => {
        value.sha256 = 'A'.repeat(64);
      },
    ],
    [
      'mismatched digest',
      (value: Record<string, unknown>) => {
        value.sha256 = '0'.repeat(64);
      },
    ],
    [
      'missing marker',
      (value: Record<string, unknown>) => {
        delete value.format;
      },
    ],
    [
      'unexpected property',
      (value: Record<string, unknown>) => {
        value.unverified = true;
      },
    ],
  ])(
    'rejects an envelope with %s without rewriting or exposing it',
    async (_description, corrupt) => {
      const cookie = await session();
      const { run } = await (await save(cookie)).json<SavedRunResponse>();
      const envelope = storedEnvelope(run.id);
      corrupt(envelope);
      const corrupted = JSON.stringify(envelope);
      db.prepare('UPDATE runs SET result = ? WHERE id = ?').run(corrupted, run.id);
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      const response = await request(`/api/runs/${run.id}`, 'GET', cookie);
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain('sha256');
      expect(JSON.stringify(log.mock.calls)).not.toContain('sha256');
      expect(db.prepare('SELECT result FROM runs WHERE id = ?').get(run.id)?.result).toBe(
        corrupted,
      );
      expect((await request(`/api/runs/${run.id}`, 'DELETE', cookie)).status).toBe(200);
    },
  );

  it.each(['null', '[]', '"text"', '42', '{', ' '.repeat(257)])(
    'rejects a malformed envelope %j',
    async (stored) => {
      const cookie = await session();
      const { run } = await (await save(cookie)).json<SavedRunResponse>();
      db.prepare('UPDATE runs SET result = ? WHERE id = ?').run(stored, run.id);
      vi.spyOn(console, 'error').mockImplementation(() => {});
      expect((await request(`/api/runs/${run.id}`, 'GET', cookie)).status).toBe(503);
    },
  );

  it('accepts equivalent envelope key order while requiring the exact supported fields', async () => {
    const cookie = await session();
    const { run } = await (await save(cookie)).json<SavedRunResponse>();
    const envelope = storedEnvelope(run.id);
    const reversed = Object.fromEntries(Object.entries(envelope).reverse());
    db.prepare('UPDATE runs SET result = ? WHERE id = ?').run(JSON.stringify(reversed), run.id);
    expect((await request(`/api/runs/${run.id}`, 'GET', cookie)).status).toBe(200);
  });

  it('rejects a changed valid scenario when metadata still matches but its digest does not', async () => {
    const cookie = await session();
    const { run } = await (await save(cookie)).json<SavedRunResponse>();
    const changed = structuredClone(run.scenario);
    changed.events[0].totalCents++;
    db.prepare('UPDATE runs SET scenario = ? WHERE id = ?').run(JSON.stringify(changed), run.id);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await request(`/api/runs/${run.id}`, 'GET', cookie)).status).toBe(503);
  });

  it('continues reading legacy full results without mutating them into digests', async () => {
    const cookie = await session();
    const { run } = await (await save(cookie)).json<SavedRunResponse>();
    const legacy = JSON.stringify(run.result);
    db.prepare('UPDATE runs SET result = ? WHERE id = ?').run(legacy, run.id);
    const response = await request(`/api/runs/${run.id}`, 'GET', cookie);
    expect(response.status).toBe(200);
    expect((await response.json<SavedRunResponse>()).run).toEqual(run);
    expect(db.prepare('SELECT result FROM runs WHERE id = ?').get(run.id)?.result).toBe(legacy);
  });
});

describe('saved replay compute limits', () => {
  function scenarioWithCounts(events: number, deliveries: number): Scenario {
    return {
      ...fixtures[0].scenario,
      events: Array.from({ length: events }, (_, index) => ({
        ...fixtures[0].scenario.events[0],
        recordId: `record-${index}`,
        eventId: `event-${index}`,
        orderId: `order-${index}`,
      })),
      deliveries: Array.from({ length: deliveries }, (_, index) => ({
        id: `delivery-${index}`,
        recordId: `record-${index % events}`,
        atMs: 0,
        fault: 'unavailable',
      })),
    };
  }

  it('saves and reads the exact 20-snapshot/40-delivery boundary with bounded output', async () => {
    const cookie = await session();
    const scenario = scenarioWithCounts(20, 40);
    const response = await request('/api/runs', 'POST', cookie, { scenario });
    expect(response.status).toBe(201);
    const { run } = await response.json<SavedRunResponse>();
    expect(run.scenario).toEqual(scenario);
    expect(run.result).toEqual(replayScenario(scenario));
    expect(new TextEncoder().encode(JSON.stringify(run.result)).byteLength).toBeLessThanOrEqual(
      512 * 1024,
    );
    expect(run.result.strategies.every((strategy) => strategy.metrics.attempts === 120)).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM runs').get()?.n).toBe(1);
    const restored = await request(`/api/runs/${run.id}`, 'GET', cookie);
    expect(restored.status).toBe(200);
    expect((await restored.json<SavedRunResponse>()).run).toEqual(run);
  });

  it.each([
    [21, 40],
    [20, 41],
    [50, 100],
  ])(
    'rejects %i snapshots/%i deliveries before replay or storage, while local replay remains valid',
    async (events, deliveries) => {
      const cookie = await session();
      const scenario = scenarioWithCounts(events, deliveries);
      expect(replayScenario(scenario).scenarioId).toBe(scenario.id);
      const engine = vi.spyOn(replayEngine, 'createReplay');
      const storage = vi.spyOn(env.DB, 'prepare');
      const response = await request('/api/runs', 'POST', cookie, { scenario });
      expect(response.status).toBe(413);
      expect((await response.json<{ error: string }>()).error).toBe(
        'Saved replays support at most 20 snapshots and 40 deliveries. Run larger scenarios locally.',
      );
      expect(engine).not.toHaveBeenCalled();
      expect(storage).not.toHaveBeenCalled();
      expect(db.prepare('SELECT COUNT(*) AS n FROM runs').get()?.n).toBe(0);
    },
  );

  it('keeps full-sized legacy saved runs readable', async () => {
    const cookie = await session();
    const { run } = await (await save(cookie)).json<SavedRunResponse>();
    const scenario = scenarioWithCounts(50, 100);
    const result = replayScenario(scenario);
    db.prepare('UPDATE runs SET event_count = ?, scenario = ?, result = ? WHERE id = ?').run(
      50,
      JSON.stringify(scenario),
      JSON.stringify(result),
      run.id,
    );
    const response = await request(`/api/runs/${run.id}`, 'GET', cookie);
    expect(response.status).toBe(200);
    const restored = await response.json<SavedRunResponse>();
    expect(restored.run.scenario).toEqual(scenario);
    expect(restored.run.result).toEqual(result);
  });
});
