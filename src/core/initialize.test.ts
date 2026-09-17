import { afterEach, expect, it, vi } from 'vitest';
import { fixtures } from './fixtures';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('initializes without runtime code generation, I/O, randomness or timers and preserves validation', async () => {
  vi.resetModules();
  vi.stubGlobal('navigator', { userAgent: 'Cloudflare-Workers' });
  const { z } = await import('zod');
  const previous = z.config().jitless;
  z.config({ jitless: true });
  const { createReplay } = await import('./replay');
  const { initializeReplay } = await import('./initialize');
  const before = createReplay(fixtures[0].scenario);
  const forbidden = vi.fn(() => {
    throw new Error('Initialization must be deterministic and local.');
  });
  vi.stubGlobal('Function', forbidden);
  vi.stubGlobal('fetch', forbidden);
  vi.stubGlobal('crypto', {
    getRandomValues: forbidden,
    randomUUID: forbidden,
    subtle: { digest: forbidden },
  });
  vi.spyOn(Date, 'now').mockImplementation(forbidden);
  vi.spyOn(Math, 'random').mockImplementation(forbidden);
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(forbidden);
  try {
    initializeReplay();
    expect(forbidden).not.toHaveBeenCalled();
    expect(createReplay(fixtures[0].scenario)).toEqual(before);
    expect(() => createReplay({ ...fixtures[0].scenario, unknown: true })).toThrow(/Unrecognized/);
    expect(() =>
      createReplay({ ...fixtures[0].scenario, events: Array.from({ length: 12_000 }, () => null) }),
    ).toThrow(/at most 50/);
    const changed = structuredClone(fixtures[0].scenario);
    changed.events[0].occurredAt = '2026-09-17T00:00:00.0001Z';
    expect(() => createReplay(changed)).toThrow(/millisecond precision/);
    expect(z.config().jitless).toBe(true);
  } finally {
    z.config({ jitless: previous });
  }
});
