import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, deleteRun, ensureSession, listRuns, loadRun, createRun } from './api';
import { fixtures } from '../core/fixtures';
import { replayScenario } from '../core/replay';

const sessionInfo = { retentionDays: 30, maxRuns: 20 };

function response(body: unknown = sessionInfo, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.stubGlobal('window', {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  });
  vi.stubGlobal('navigator', {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('anonymous session initialization', () => {
  it('waits for the same-origin browser lock before reading or creating a credential', async () => {
    const acquired = deferred<void>();
    const lock = vi
      .fn()
      .mockImplementation(
        async (_name: string, _options: unknown, callback: () => Promise<unknown>) => {
          await acquired.promise;
          return callback();
        },
      );
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response());
    vi.stubGlobal('navigator', { locks: { request: lock } });
    vi.stubGlobal('fetch', fetchMock);
    const first = ensureSession();
    const second = ensureSession();
    expect(lock).toHaveBeenCalledTimes(1);
    expect(lock.mock.calls[0][0]).toBe('integration-replay-lab-session');
    expect(fetchMock).not.toHaveBeenCalled();
    acquired.resolve();
    expect(await Promise.all([first, second])).toEqual([sessionInfo, sessionInfo]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('bounds lock acquisition and permits a later initialization retry', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    const lock = vi
      .fn()
      .mockImplementationOnce(
        (_name: string, options: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError')),
            );
          }),
      )
      .mockImplementationOnce(
        (_name: string, _options: unknown, callback: () => Promise<unknown>) => callback(),
      );
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response());
    vi.stubGlobal('navigator', { locks: { request: lock } });
    vi.stubGlobal('fetch', fetchMock);
    const pending = expect(ensureSession()).rejects.toThrow('Another tab is still connecting');
    await vi.advanceTimersByTimeAsync(30_000);
    await pending;
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(await ensureSession()).toEqual(sessionInfo);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shares an in-flight lookup and rechecks the browser credential on a later call', async () => {
    const lookup = deferred<Response>();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockReturnValueOnce(lookup.promise)
      .mockResolvedValueOnce(response());
    vi.stubGlobal('fetch', fetchMock);

    const startup = ensureSession();
    const save = ensureSession();
    const refresh = ensureSession();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/session');
    expect(fetchMock.mock.calls[0][1]?.method ?? 'GET').toBe('GET');

    lookup.resolve(response());
    expect(await Promise.all([startup, save, refresh])).toEqual([
      sessionInfo,
      sessionInfo,
      sessionInfo,
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    expect(await ensureSession()).toEqual(sessionInfo);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('creates only one credential after a shared 401, including callers arriving during creation', async () => {
    const lookup = deferred<Response>();
    const creation = deferred<Response>();
    const creationStarted = deferred<void>();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockReturnValueOnce(lookup.promise)
      .mockImplementationOnce(() => {
        creationStarted.resolve();
        return creation.promise;
      });
    vi.stubGlobal('fetch', fetchMock);

    const startup = ensureSession();
    const save = ensureSession();
    lookup.resolve(response({ error: 'Create a browser workspace first.' }, 401));
    await creationStarted.promise;
    const lateCaller = ensureSession();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe('/api/session');
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      method: 'POST',
      body: '{}',
      credentials: 'same-origin',
    });
    creation.resolve(response());

    expect(await Promise.all([startup, save, lateCaller])).toEqual([
      sessionInfo,
      sessionInfo,
      sessionInfo,
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('releases a failed shared lookup so a later attempt can recover without creating an extra session', async () => {
    const lookup = deferred<Response>();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockReturnValueOnce(lookup.promise)
      .mockResolvedValueOnce(response());
    vi.stubGlobal('fetch', fetchMock);

    const failures = Promise.allSettled([ensureSession(), ensureSession()]);
    lookup.reject(new TypeError('Network unavailable'));
    const outcomes = await failures;

    expect(
      outcomes.every(
        (outcome) => outcome.status === 'rejected' && outcome.reason instanceof ApiError,
      ),
    ).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await ensureSession()).toEqual(sessionInfo);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET')).toBe(true);
  });

  it('releases a failed creation so recovery can perform one new lookup and creation', async () => {
    const creation = deferred<Response>();
    const creationStarted = deferred<void>();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ error: 'Session missing' }, 401))
      .mockImplementationOnce(() => {
        creationStarted.resolve();
        return creation.promise;
      })
      .mockResolvedValueOnce(response({ error: 'Session still missing' }, 401))
      .mockResolvedValueOnce(response());
    vi.stubGlobal('fetch', fetchMock);

    const failures = Promise.allSettled([ensureSession(), ensureSession()]);
    await creationStarted.promise;
    creation.resolve(response({ error: 'Storage temporarily unavailable' }, 503));
    const outcomes = await failures;
    expect(
      outcomes.every(
        (outcome) =>
          outcome.status === 'rejected' &&
          outcome.reason instanceof ApiError &&
          outcome.reason.status === 503,
      ),
    ).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    expect(await ensureSession()).toEqual(sessionInfo);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.map(([, init]) => init?.method ?? 'GET')).toEqual([
      'GET',
      'POST',
      'GET',
      'POST',
    ]);
  });
});

describe('storage response boundary', () => {
  const scenario = fixtures[0].scenario;
  const summary = {
    id: '8adf2cd7-2c72-4ce3-8818-ff272268c746',
    title: scenario.title,
    origin: scenario.origin,
    createdAt: '2026-09-17T00:00:00.000Z',
    eventCount: scenario.events.length,
  };

  it.each([{}, null, { retentionDays: -1, maxRuns: 20 }, { retentionDays: 30, maxRuns: '20' }])(
    'rejects a malformed successful session response without creating another session',
    async (body) => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response(body));
      vi.stubGlobal('fetch', fetchMock);
      await expect(ensureSession()).rejects.toThrow('invalid response');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    {},
    { runs: null },
    { runs: [{ ...summary, id: '../unexpected' }] },
    { runs: [{ ...summary, createdAt: 'not a date' }] },
  ])(
    'rejects a malformed library response rather than passing unsafe render state',
    async (body) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(body)));
      await expect(listRuns()).rejects.toThrow('invalid response');
    },
  );

  it('accepts valid summaries, reports and confirmed deletion', async () => {
    const run = { ...summary, scenario, result: replayScenario(scenario) };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ runs: [summary] }))
      .mockResolvedValueOnce(response({ run }))
      .mockResolvedValueOnce(response({ run }, 201))
      .mockResolvedValueOnce(response({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await listRuns()).toEqual([summary]);
    expect(await loadRun(summary.id)).toEqual(run);
    expect(await createRun(scenario)).toEqual(run);
    await expect(deleteRun(summary.id)).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[2][1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ scenario }),
    });
    expect(fetchMock.mock.calls[3][1]).toMatchObject({ method: 'DELETE' });
  });

  it('rejects missing and corrupt saved traces, including a malformed successful save', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(response({}))
        .mockResolvedValueOnce(
          response({
            run: {
              ...summary,
              scenario: { ...scenario, events: [] },
              result: replayScenario(scenario),
            },
          }),
        )
        .mockResolvedValueOnce(
          response({ run: { ...summary, scenario: null, result: replayScenario(scenario) } }, 201),
        ),
    );
    await expect(loadRun(summary.id)).rejects.toThrow('invalid response');
    await expect(loadRun(summary.id)).rejects.toThrow('saved replay is invalid');
    await expect(createRun(scenario)).rejects.toThrow('saved replay is invalid');
  });

  it('does not present an unconfirmed deletion as success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ ok: false })));
    await expect(deleteRun(summary.id)).rejects.toThrow('invalid response');
  });

  it('preserves rate-limit timing and request identity in API errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ error: 'Please slow down.', requestId: 'request-example' }),
            { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '60' } },
          ),
        ),
    );
    await expect(createRun(scenario)).rejects.toMatchObject({
      message: 'Please slow down.',
      status: 429,
      requestId: 'request-example',
      retryAfter: '60',
    });
  });

  it('handles non-JSON responses and broken JSON without exposing parser internals', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response('<html>down</html>', {
            status: 503,
            headers: { 'Content-Type': 'text/html' },
          }),
        )
        .mockResolvedValueOnce(
          new Response('{', { headers: { 'Content-Type': 'application/json' } }),
        ),
    );
    await expect(listRuns()).rejects.toThrow('Server replay is unavailable');
    await expect(listRuns()).rejects.toThrow('invalid JSON');
  });

  it('aborts a stalled save without retrying an uncertain mutation', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(
      (_path, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const pending = expect(createRun(scenario)).rejects.toThrow(
      'timed out. Refresh saved replays before running again',
    );
    await vi.advanceTimersByTimeAsync(15_000);
    await pending;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
