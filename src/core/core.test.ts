import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixtures } from './fixtures';
import { createReplay, replayScenario } from './replay';
import { parseSavedReplay } from './result';
import {
  MAX_SCENARIO_BYTES,
  parseScenario,
  parseScenarioText,
  ScenarioSizeError,
  ScenarioValidationError,
  type OrderEvent,
  type Scenario,
} from './schema';

function fixture(id = 'duplicate-delivery'): Scenario {
  return structuredClone(fixtures.find((item) => item.id === id)!.scenario);
}

function robust(scenario: Scenario) {
  return replayScenario(scenario).strategies.find((strategy) => strategy.id === 'robust')!;
}

function addRecord(scenario: Scenario, changes: Partial<OrderEvent>, atMs = 200) {
  const event: OrderEvent = {
    ...scenario.events[0],
    recordId: `record-${scenario.events.length + 1}`,
    eventId: `event-${scenario.events.length + 1}`,
    ...changes,
  };
  scenario.events.push(event);
  scenario.deliveries.push({
    id: `delivery-extra-${scenario.deliveries.length + 1}`,
    recordId: event.recordId,
    atMs,
    fault: 'none',
  });
  return event;
}

function maximumScenario(mixedFaults = false): Scenario {
  const id = (prefix: string, index: number) => `${prefix}${String(index).padStart(63, '0')}`;
  return {
    schemaVersion: 1,
    id: 'maximum-bounds',
    title: 'Maximum bounded delivery replay',
    origin: 'fixture',
    events: Array.from({ length: 50 }, (_, index) => ({
      recordId: id('r', index),
      eventId: id('e', index),
      orderId: id('o', index),
      revision: Number.MAX_SAFE_INTEGER,
      status: 'paid',
      totalCents: Number.MAX_SAFE_INTEGER,
      occurredAt: '2026-02-10T10:00:00Z',
    })),
    deliveries: Array.from({ length: 100 }, (_, index) => ({
      id: id('d', index),
      recordId: id('r', index % 50),
      atMs: 0,
      fault: mixedFaults && index % 2 === 0 ? 'timeout-after' : 'unavailable',
    })),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('strict scenario validation', () => {
  it('accepts all authored fixtures and does not mutate scenario inputs', () => {
    expect(fixtures).toHaveLength(4);
    for (const item of fixtures) {
      const before = JSON.stringify(item.scenario);
      expect(parseScenarioText(before)).toEqual(item.scenario);
      replayScenario(item.scenario);
      expect(JSON.stringify(item.scenario)).toBe(before);
    }
  });

  it('rejects unknown keys, invalid versions and malformed JSON', () => {
    expect(() => parseScenario({ ...fixture(), unknown: true })).toThrow(/Unrecognized/);
    expect(() => parseScenario({ ...fixture(), schemaVersion: 2 })).toThrow(/schemaVersion/);
    expect(() => parseScenarioText('{')).toThrow(/Invalid JSON/);
    expect(() =>
      parseScenarioText(JSON.stringify(fixture()).replace('{', '{"__proto__":{},')),
    ).toThrow(/Unrecognized/);
  });

  it('validates exact money integers, revisions, statuses and timestamps', () => {
    for (const totalCents of [-1, 1.25, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      const scenario = fixture();
      scenario.events[0].totalCents = totalCents;
      expect(() => parseScenario(scenario)).toThrow(/totalCents/);
    }
    const zero = fixture();
    zero.events[0].totalCents = 0;
    expect(parseScenario(zero).events[0].totalCents).toBe(0);
    const event = fixture().events[0];
    for (const changes of [
      { revision: 0 },
      { revision: 1.5 },
      { status: 'unknown' },
      { occurredAt: 'yesterday' },
    ]) {
      expect(() => parseScenario({ ...fixture(), events: [{ ...event, ...changes }] })).toThrow();
    }
  });

  it('rejects submillisecond timestamps instead of collapsing distinct content into one identity', () => {
    const scenario = fixture();
    for (const occurredAt of ['2026-02-10T10:01:00.0001Z', '2026-02-10T10:01:00.0002Z']) {
      expect(() =>
        parseScenario({ ...scenario, events: [{ ...scenario.events[0], occurredAt }] }),
      ).toThrow(/millisecond precision/);
    }
    expect(() =>
      parseScenario({
        ...scenario,
        events: [
          { ...scenario.events[0], occurredAt: `2026-02-10T10:01:00.${'0'.repeat(50_000)}Z` },
        ],
      }),
    ).toThrow(/occurredAt/);
    scenario.events[0].occurredAt = '2026-02-10T10:01:00.123Z';
    addRecord(scenario, { occurredAt: '2026-02-10T11:01:00.123+01:00' });
    const result = robust(scenario);
    expect(result.metrics).toMatchObject({ applied: 1, duplicates: 2, conflicts: 0 });
    expect(result.finalOrders[0].occurredAt).toBe('2026-02-10T10:01:00.123Z');
  });

  it('rejects duplicate internal records and delivery IDs, but permits external event-ID collisions', () => {
    const duplicateRecord = fixture();
    duplicateRecord.events.push({ ...duplicateRecord.events[0] });
    expect(() => parseScenario(duplicateRecord)).toThrow(/Duplicate record ID/);
    const duplicateDelivery = fixture();
    duplicateDelivery.deliveries[1].id = duplicateDelivery.deliveries[0].id;
    expect(() => parseScenario(duplicateDelivery)).toThrow(/Duplicate delivery ID/);
    const collision = fixture();
    addRecord(collision, { eventId: collision.events[0].eventId, totalCents: 42 });
    expect(parseScenario(collision).events).toHaveLength(2);
  });

  it('validates delivery references, clock limits and supported faults', () => {
    const scenario = fixture();
    scenario.deliveries[0].recordId = 'missing';
    expect(() => parseScenario(scenario)).toThrow(/unknown record/);
    for (const changes of [
      { atMs: -1 },
      { atMs: 0.5 },
      { atMs: 86_400_001 },
      { fault: 'random' },
    ]) {
      expect(() =>
        parseScenario({ ...fixture(), deliveries: [{ ...fixture().deliveries[0], ...changes }] }),
      ).toThrow();
    }
  });

  it('accepts exact collection and byte limits, then rejects inputs beyond them', () => {
    const maximum = maximumScenario();
    const parsed = parseScenario(maximum);
    expect(parsed.events).toHaveLength(50);
    expect(parsed.deliveries).toHaveLength(100);
    expect(() =>
      parseScenario({
        ...maximum,
        events: [...maximum.events, { ...maximum.events[0], recordId: 'record-51' }],
      }),
    ).toThrow(/50/);
    expect(() =>
      parseScenario({
        ...maximum,
        deliveries: [...maximum.deliveries, { ...maximum.deliveries[0], id: 'delivery-101' }],
      }),
    ).toThrow(/100/);
    const text = JSON.stringify(maximum);
    expect(new TextEncoder().encode(text).byteLength).toBeLessThan(MAX_SCENARIO_BYTES);
    expect(parseScenarioText(text.padEnd(MAX_SCENARIO_BYTES)).deliveries).toHaveLength(100);
    expect(() => parseScenarioText(text.padEnd(MAX_SCENARIO_BYTES + 1))).toThrow(/64 KiB/);
    expect(() => parseScenarioText('🙂'.repeat(MAX_SCENARIO_BYTES / 4 + 1))).toThrow(/64 KiB/);
  });

  it('rejects oversized malformed collections by count before traversing their elements', () => {
    for (const [key, limit] of [
      ['events', 50],
      ['deliveries', 100],
    ] as const) {
      const scenario = { ...fixture(), [key]: Array.from({ length: 12_000 }, () => null) };
      expect(new TextEncoder().encode(JSON.stringify(scenario)).byteLength).toBeLessThan(
        MAX_SCENARIO_BYTES,
      );
      expect(() => parseScenario(scenario)).toThrow(`${key}: Use at most ${limit} items.`);
    }
  });

  it('distinguishes intentional validation errors and byte limits from unexpected failures', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    for (const invalid of [
      undefined,
      null,
      circular,
      { value: 1n },
      { ...fixture(), title: ' ' },
    ]) {
      expect(() => parseScenario(invalid)).toThrow(ScenarioValidationError);
    }
    expect(() => parseScenarioText('{')).toThrow(ScenarioValidationError);
    expect(() => parseScenarioText(' '.repeat(MAX_SCENARIO_BYTES + 1))).toThrow(ScenarioSizeError);
    expect(() => parseScenarioText(' '.repeat(MAX_SCENARIO_BYTES + 1))).toThrow(
      ScenarioValidationError,
    );
  });

  it('keeps map-backed identities safe for names used by object prototypes', () => {
    const scenario = fixture();
    Object.assign(scenario.events[0], {
      recordId: 'constructor',
      eventId: 'toString',
      orderId: 'hasOwnProperty',
    });
    for (const delivery of scenario.deliveries) delivery.recordId = 'constructor';
    const result = robust(scenario);
    expect(result.metrics).toMatchObject({ applied: 1, duplicates: 1, conflicts: 0 });
    expect(result.finalOrders[0].orderId).toBe('hasOwnProperty');
    expect(Object.prototype).not.toHaveProperty('revision');
  });
});

describe('saved artifact integrity', () => {
  it('returns the validated input with its replay without retaining caller-owned objects', () => {
    const input = fixture();
    const replay = createReplay(input);
    expect(replay.result).toEqual(replayScenario(input));
    expect(replay.scenario).toEqual(input);
    expect(replay.scenario).not.toBe(input);
    input.events[0].totalCents = 0;
    expect(replay.scenario.events[0].totalCents).toBe(12900);
  });

  it('accepts equivalent JSON object property order and preserves the recorded engine version', () => {
    function reverseKeys(input: unknown): unknown {
      if (Array.isArray(input)) return input.map(reverseKeys);
      if (input !== null && typeof input === 'object') {
        return Object.fromEntries(
          Object.entries(input)
            .reverse()
            .map(([key, value]) => [key, reverseKeys(value)]),
        );
      }
      return input;
    }
    const scenario = fixture();
    const result = replayScenario(scenario);
    expect(parseSavedReplay(scenario, reverseKeys(result))).toEqual({ scenario, result });
  });

  it('rejects unsupported historical engines rather than silently treating their output as current', () => {
    const scenario = fixture();
    expect(() =>
      parseSavedReplay(scenario, { ...replayScenario(scenario), engineVersion: '0.9.0' }),
    ).toThrow(/unsupported engine version/);
    for (const result of [null, [], 'result', 0])
      expect(() => parseSavedReplay(scenario, result)).toThrow(/must be an object/);
  });

  it('rejects altered metadata, decisions, state, effects, metrics, warnings and extra properties', () => {
    const scenario = fixture();
    const baseline = replayScenario(scenario);
    const alterations: ((result: ReturnType<typeof replayScenario>) => void)[] = [
      (result) => {
        result.scenarioId = 'wrong-scenario';
      },
      (result) => {
        result.strategies.reverse();
      },
      (result) => {
        result.strategies[1].attempts[1].decision = 'applied';
      },
      (result) => {
        result.strategies[1].attempts.reverse();
      },
      (result) => {
        result.strategies[1].finalOrders[0].totalCents = 0;
      },
      (result) => {
        result.strategies[1].effects.push(result.strategies[1].effects[0]);
      },
      (result) => {
        result.strategies[1].metrics.conflicts = 1;
      },
      (result) => {
        result.warnings = [];
      },
      (result) => {
        Object.assign(result.strategies[1].metrics, { unverified: true });
      },
    ];
    for (const alter of alterations) {
      const result = structuredClone(baseline);
      alter(result);
      expect(() => parseSavedReplay(scenario, result)).toThrow(/does not match/);
    }
    const unavailable = fixture('permanent-failure');
    const altered = replayScenario(unavailable);
    altered.strategies[1].deadLetters[0].attempts = 1;
    expect(() => parseSavedReplay(unavailable, altered)).toThrow(/does not match/);
    const prototypeProperty = JSON.parse(
      JSON.stringify(baseline).replace('{', '{"__proto__":{},'),
    ) as unknown;
    expect(() => parseSavedReplay(scenario, prototypeProperty)).toThrow(/does not match/);
  });

  it('rejects huge unexpected collections without recursively validating their content', () => {
    const scenario = fixture();
    const malformed = {
      ...replayScenario(scenario),
      strategies: Array.from({ length: 12_000 }, () => null),
    };
    expect(() => parseSavedReplay(scenario, malformed)).toThrow(/does not match/);
  });
});

describe('delivery and retry semantics', () => {
  it('shows duplicate effects in the naive consumer and one robust effect', () => {
    const [naive, safe] = replayScenario(fixture()).strategies;
    expect(naive.metrics).toMatchObject({
      received: 2,
      applied: 2,
      sideEffects: 2,
      duplicateEffects: 1,
    });
    expect(safe.metrics).toMatchObject({
      received: 2,
      applied: 1,
      duplicates: 1,
      sideEffects: 1,
      duplicateEffects: 0,
    });
    expect(safe.attempts.map((attempt) => attempt.decision)).toEqual(['applied', 'duplicate']);
  });

  it('protects the latest full snapshot when an older revision arrives later', () => {
    const [naive, safe] = replayScenario(fixture('out-of-order')).strategies;
    expect(naive.finalOrders[0]).toMatchObject({ revision: 1, status: 'created' });
    expect(safe.finalOrders[0]).toMatchObject({ revision: 2, status: 'paid' });
    expect(safe.metrics.stale).toBe(1);
  });

  it('models a lost acknowledgement after processing without rolling back the commit', () => {
    const [naive, safe] = replayScenario(fixture('timeout-after-commit')).strategies;
    expect(
      safe.attempts.map(({ timeMs, transport, decision }) => ({ timeMs, transport, decision })),
    ).toEqual([
      { timeMs: 0, transport: 'timeout-after', decision: 'applied' },
      { timeMs: 1000, transport: 'acknowledged', decision: 'duplicate' },
    ]);
    expect(naive.metrics.sideEffects).toBe(2);
    expect(safe.metrics.sideEffects).toBe(1);
    expect(safe.deadLetters).toHaveLength(0);
  });

  it('does not commit or consume an identity on a timeout before delivery', () => {
    const scenario = fixture('timeout-after-commit');
    scenario.deliveries[0].fault = 'timeout-before';
    const result = robust(scenario);
    expect(result.attempts.map((attempt) => attempt.decision)).toEqual(['not-received', 'applied']);
    expect(result.metrics).toMatchObject({
      attempts: 2,
      received: 1,
      applied: 1,
      duplicates: 0,
      sideEffects: 1,
    });
  });

  it('bounds permanent failure to attempts at 0, 1000 and 3000 ms then dead-letters', () => {
    const result = robust(fixture('permanent-failure'));
    expect(result.attempts.map((attempt) => attempt.timeMs)).toEqual([0, 1000, 3000]);
    expect(result.attempts.every((attempt) => attempt.decision === 'not-received')).toBe(true);
    expect(result.metrics).toMatchObject({
      attempts: 3,
      received: 0,
      applied: 0,
      deadLetters: 1,
      sideEffects: 0,
    });
    expect(result.deadLetters[0]).toMatchObject({ attempts: 3, lastTimeMs: 3000 });
    expect(result.finalOrders).toEqual([]);
  });

  it('orders equal-time initial deliveries before a retry scheduled later', () => {
    const scenario = fixture('timeout-after-commit');
    addRecord(
      scenario,
      { revision: 3, status: 'shipped', occurredAt: '2026-02-10T10:02:00Z' },
      1000,
    );
    const [naive, safe] = replayScenario(scenario).strategies;
    expect(
      safe.attempts.map(({ deliveryId, attempt, timeMs }) => ({ deliveryId, attempt, timeMs })),
    ).toEqual([
      { deliveryId: 'delivery-1', attempt: 1, timeMs: 0 },
      { deliveryId: 'delivery-extra-2', attempt: 1, timeMs: 1000 },
      { deliveryId: 'delivery-1', attempt: 2, timeMs: 1000 },
    ]);
    expect(safe.finalOrders[0].revision).toBe(3);
    expect(naive.finalOrders[0].revision).toBe(2);
  });

  it('keeps retry ties stable and permits the final bounded retry beyond the initial clock limit', () => {
    const scenario = fixture('permanent-failure');
    scenario.deliveries[0].atMs = 86_400_000;
    scenario.deliveries.push({ ...scenario.deliveries[0], id: 'delivery-2' });
    const result = robust(scenario);
    expect(
      result.attempts.map(({ deliveryId, attempt, timeMs }) => [deliveryId, attempt, timeMs]),
    ).toEqual([
      ['delivery-1', 1, 86_400_000],
      ['delivery-2', 1, 86_400_000],
      ['delivery-1', 2, 86_401_000],
      ['delivery-2', 2, 86_401_000],
      ['delivery-1', 3, 86_403_000],
      ['delivery-2', 3, 86_403_000],
    ]);
    expect(result.deadLetters.map((letter) => letter.lastTimeMs)).toEqual([86_403_000, 86_403_000]);
  });

  it('uses virtual schedule order, with input-array order as the initial tie-breaker', () => {
    const scenario = fixture('out-of-order');
    scenario.deliveries[0].atMs = 500;
    scenario.deliveries[1].atMs = 0;
    expect(robust(scenario).attempts.map((attempt) => attempt.revision)).toEqual([1, 2]);
    scenario.deliveries[0].atMs = 0;
    expect(robust(scenario).attempts.map((attempt) => attempt.revision)).toEqual([2, 1]);
  });
});

describe('identity, revision and outbox invariants', () => {
  it('quarantines changed payloads under an already received event ID', () => {
    const scenario = fixture();
    addRecord(scenario, { eventId: scenario.events[0].eventId, revision: 3, totalCents: 5 });
    const result = robust(scenario);
    expect(result.attempts.at(-1)?.decision).toBe('conflict');
    expect(result.finalOrders[0].totalCents).toBe(12900);
    expect(result.metrics.sideEffects).toBe(1);
    expect(result.deadLetters).toEqual([]);
  });

  it('quarantines the same order revision with different content under a new event ID', () => {
    const scenario = fixture();
    addRecord(scenario, { status: 'cancelled' });
    const result = robust(scenario);
    expect(result.attempts.at(-1)?.decision).toBe('conflict');
    expect(result.finalOrders[0].status).toBe('paid');
    expect(result.metrics.conflicts).toBe(1);
  });

  it('keeps conflicting payloads quarantined across a lost-ack retry', () => {
    const scenario = fixture();
    addRecord(scenario, { status: 'cancelled' });
    scenario.deliveries.at(-1)!.fault = 'timeout-after';
    const result = robust(scenario);
    expect(result.attempts.slice(-2).map((attempt) => attempt.decision)).toEqual([
      'conflict',
      'conflict',
    ]);
    expect(result.attempts.at(-1)?.transport).toBe('acknowledged');
    expect(result.metrics.conflicts).toBe(2);
    expect(result.metrics.sideEffects).toBe(1);
  });

  it('remembers first-seen identity even when that payload was quarantined', () => {
    const scenario = fixture();
    const bad = addRecord(scenario, { status: 'cancelled' });
    addRecord(scenario, { eventId: bad.eventId, status: 'paid' }, 300);
    const result = robust(scenario);
    expect(result.attempts.slice(-2).map((attempt) => attempt.decision)).toEqual([
      'conflict',
      'conflict',
    ]);
    expect(result.attempts.at(-1)?.reason).toMatch(/event ID/);
  });

  it('deduplicates identical revisions under different event IDs and equivalent timestamp encodings', () => {
    const scenario = fixture();
    addRecord(scenario, { occurredAt: '2026-02-10T11:01:00+01:00' });
    const result = robust(scenario);
    expect(result.metrics).toMatchObject({
      applied: 1,
      duplicates: 2,
      conflicts: 0,
      sideEffects: 1,
    });
    expect(result.finalOrders[0].occurredAt).toBe('2026-02-10T10:01:00.000Z');
  });

  it('remembers ignored stale snapshots for later revision-conflict checks', () => {
    const scenario = fixture('out-of-order');
    addRecord(scenario, { revision: 1, status: 'refunded' });
    const result = robust(scenario);
    expect(result.attempts.map((attempt) => attempt.decision)).toEqual([
      'applied',
      'stale',
      'conflict',
    ]);
    expect(result.finalOrders[0].revision).toBe(2);
  });

  it('supports full-snapshot revision gaps without claiming missing delta recovery', () => {
    const scenario = fixture();
    addRecord(scenario, { revision: 100, status: 'refunded' });
    const result = robust(scenario);
    expect(result.finalOrders[0]).toMatchObject({ revision: 100, status: 'refunded' });
    expect(result.metrics.applied).toBe(2);
  });

  it('keeps revision and effect identities separate across orders', () => {
    const scenario = fixture();
    addRecord(scenario, { orderId: 'order-2' });
    const result = robust(scenario);
    expect(result.finalOrders).toHaveLength(2);
    expect(new Set(result.effects.map((effect) => effect.key)).size).toBe(2);
    expect(result.metrics.duplicateEffects).toBe(0);
  });

  it('treats event IDs as global even when changed content names another order', () => {
    const scenario = fixture();
    addRecord(scenario, { orderId: 'another-order', eventId: scenario.events[0].eventId });
    const result = robust(scenario);
    expect(result.attempts.at(-1)?.decision).toBe('conflict');
    expect(result.finalOrders.map((order) => order.orderId)).toEqual([scenario.events[0].orderId]);
    expect(result.metrics.sideEffects).toBe(1);
  });

  it('never decreases applied revisions and emits at most one effect per order revision', () => {
    const scenario = fixture();
    scenario.deliveries = scenario.deliveries.slice(0, 1);
    for (const revision of [8, 3, 8, 10, 1, 5, 10, 12]) {
      addRecord(scenario, { revision, status: 'paid' }, scenario.deliveries.length * 10);
    }
    const result = robust(scenario);
    const applied = result.attempts
      .filter((attempt) => attempt.decision === 'applied')
      .map((attempt) => attempt.revision);
    expect(applied).toEqual([2, 8, 10, 12]);
    expect(result.effects).toHaveLength(new Set(result.effects.map((effect) => effect.key)).size);
    expect(result.metrics.duplicateEffects).toBe(0);
  });
});

describe('determinism and bounded execution', () => {
  it('uses no network, wall clock, randomness or actual waits', () => {
    const forbidden = vi.fn(() => {
      throw new Error('External execution is forbidden.');
    });
    vi.stubGlobal('fetch', forbidden);
    const now = vi.spyOn(Date, 'now').mockImplementation(forbidden);
    const random = vi.spyOn(Math, 'random').mockImplementation(forbidden);
    const wait = vi.spyOn(globalThis, 'setTimeout').mockImplementation(forbidden);
    for (const item of fixtures)
      expect(replayScenario(item.scenario)).toEqual(replayScenario(item.scenario));
    expect(forbidden).not.toHaveBeenCalled();
    now.mockRestore();
    random.mockRestore();
    wait.mockRestore();
  });

  it('keeps observed transport schedules equal across strategies and reports honest simulation boundaries', () => {
    const report = replayScenario(fixture('timeout-after-commit'));
    expect(report.mode).toBe('simulation');
    expect(report.origin).toBe('fixture');
    expect(
      report.strategies.map((strategy) =>
        strategy.attempts.map(({ timeMs, transport, attempt }) => ({ timeMs, transport, attempt })),
      )[0],
    ).toEqual(
      report.strategies[1].attempts.map(({ timeMs, transport, attempt }) => ({
        timeMs,
        transport,
        attempt,
      })),
    );
    expect(report.warnings.some((warning) => warning.includes('not production reliability'))).toBe(
      true,
    );
    expect(report.warnings.some((warning) => warning.includes('atomic'))).toBe(true);
  });

  it('bounds maximum retries and output size, with a generous local performance ceiling', () => {
    const permanent = replayScenario(maximumScenario());
    const permanentBytes = new TextEncoder().encode(JSON.stringify(permanent)).byteLength;
    expect(permanentBytes).toBeLessThanOrEqual(512 * 1024);
    for (const strategy of permanent.strategies) {
      expect(strategy.attempts).toHaveLength(300);
      expect(strategy.deadLetters).toHaveLength(100);
      expect(strategy.metrics.received).toBe(0);
    }
    const scenario = maximumScenario(true);
    const report = replayScenario(scenario);
    for (const strategy of report.strategies) {
      expect(strategy.attempts).toHaveLength(250);
      expect(strategy.deadLetters).toHaveLength(50);
      expect(strategy.metrics.received).toBe(100);
    }
    const inputBytes = new TextEncoder().encode(JSON.stringify(scenario)).byteLength;
    const outputBytes = new TextEncoder().encode(JSON.stringify(report)).byteLength;
    expect(outputBytes).toBeLessThanOrEqual(512 * 1024);
    expect(parseSavedReplay(scenario, report).result).toEqual(report);
    expect(parseSavedReplay(maximumScenario(), permanent).result).toEqual(permanent);
    const durations: number[] = [];
    for (let i = 0; i < 3; i++) replayScenario(scenario);
    for (let i = 0; i < 15; i++) {
      const started = performance.now();
      replayScenario(scenario);
      durations.push(performance.now() - started);
    }
    durations.sort((a, b) => a - b);
    const medianMs = durations[7];
    const validationDurations: number[] = [];
    for (let i = 0; i < 15; i++) {
      const started = performance.now();
      parseSavedReplay(scenario, report);
      validationDurations.push(performance.now() - started);
    }
    validationDurations.sort((a, b) => a - b);
    const validationMedianMs = validationDurations[7];
    process.stdout.write(
      `Bounded local simulation: ${inputBytes} input bytes, ${outputBytes} mixed-fault result bytes, ${permanentBytes} permanent-failure result bytes; 50 events, 100 deliveries, 500 mixed-fault or 600 permanent-failure combined attempts; replay median ${medianMs.toFixed(3)} ms and saved-result verification median ${validationMedianMs.toFixed(3)} ms across 15 mixed-fault runs. IDs use 64 characters and revision/amount use maximum safe integers. Not a cloud CPU measurement.\n`,
    );
    expect(medianMs).toBeLessThan(100);
    expect(validationMedianMs).toBeLessThan(100);
  });
});
