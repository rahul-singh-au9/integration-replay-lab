import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { fixtures } from './fixtures';
import { replayScenario } from './replay';
import type { Fault, OrderStatus, Scenario } from './schema';

function generatedScenario(seed: number): Scenario {
  let state = seed;
  const next = () => (state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0);
  const statuses: OrderStatus[] = ['created', 'paid', 'shipped', 'cancelled', 'refunded'];
  const faults: Fault[] = ['none', 'timeout-before', 'timeout-after', 'unavailable'];
  return {
    schemaVersion: 1,
    id: `schedule-${seed}`,
    title: `Deterministic schedule ${seed}`,
    origin: 'fixture',
    events: Array.from({ length: 50 }, (_, index) => ({
      recordId: `record-${index}`,
      eventId: `event-${next() % 25}`,
      orderId: `order-${next() % 8}`,
      revision: (next() % 12) + 1,
      status: statuses[next() % statuses.length],
      totalCents: (next() % 20) * 1000,
      occurredAt: '2026-09-17T00:00:00Z',
    })),
    deliveries: Array.from({ length: 100 }, (_, index) => ({
      id: `delivery-${index}`,
      recordId: `record-${next() % 50}`,
      atMs: (next() % 20) * 1000,
      fault: faults[next() % faults.length],
    })),
  };
}

// Recorded against the original stable sorted queue before replacing its implementation.
const baselineDigests: string[] = [
  '42f4ed5f05fad9a290eec2f221be2722a4b20cbef98ca5be20a94223db1b4779',
  '4dc2daa45bfd0a6cfacf9592725b08bef1f0ddced68f22a7bdf81a24ec9706ba',
  'b73985463304a50c3ff8259fb229a3d96c20231586b056527c86d7efc6f10e87',
  '7dc0e819be0e74b0f5789b36f4143b2c910b55414b1aa0f4149a8f03717e59e3',
  '7dab6288197837f5ea0ac05b9bb5abe230f4d063d1af68994dc150868f6ea9ce',
  '810649a331a3c672208a33e79abad1c81d09864cf71984ceaea37e9e9adf956b',
  '033a2823f894401f3b119f340e76788b79523289f3083adf254ce3a3a7eb2577',
  '3fa08940e6d8b2d05365f3682eea9f643dc520f752a444c50e370a5224e34ef1',
  '00e4efebb6300e51cb976ede31b4e6d52c50f2c7d900e5ce2b1dea6fc7e5fe8d',
  'ce960d9ec3f71c8ec605177d629eb1a9f47c47e24e6b5e7a8191875bf4fdd708',
  '3226a04d347070c49c78fbe803571de8413837be91fef3973967526e40832f2b',
  'ee5280e035f8434e131bef9869d747d4c71c8e4dc08400f62b5aefb12d172e61',
  '9da75e668c7d6780424d2f1d209788b37eae101d95681ac44e0b3c05c35fb75e',
  '747ba83bfabf00fe3bbf6e571e7ce34aba6a0f45351536c327adbfa1dba64002',
  '979a216b291277114fe3cee59c5ad3a6106a0d083904e8ca0be65b6079035878',
  'ef9fc9543cbb7eac336092c6975aaf7b63612a123ed4d429e4f7193984be07b8',
];

it('preserves complete replay artifacts for fixtures and twelve seeded maximum-size schedules', () => {
  const scenarios = [
    ...fixtures.map((item) => item.scenario),
    ...Array.from({ length: 12 }, (_, index) => generatedScenario(index + 1)),
  ];
  expect(scenarios).toHaveLength(baselineDigests.length);
  for (const [index, scenario] of scenarios.entries()) {
    const digest = createHash('sha256')
      .update(JSON.stringify(replayScenario(scenario)))
      .digest('hex');
    expect(digest, scenario.id).toBe(baselineDigests[index]);
  }
});

it('matches an independent sorted schedule for every original and retried delivery', () => {
  for (let seed = 1; seed <= 12; seed++) {
    const scenario = generatedScenario(seed);
    const pending = scenario.deliveries.map((delivery, ordinal) => ({
      delivery,
      ordinal,
      attempt: 1,
      timeMs: delivery.atMs,
    }));
    let ordinal = pending.length;
    const expected = [];
    while (pending.length) {
      pending.sort((left, right) => left.timeMs - right.timeMs || left.ordinal - right.ordinal);
      const current = pending.shift()!;
      const transport =
        current.delivery.fault === 'unavailable'
          ? 'unavailable'
          : current.attempt === 1 && current.delivery.fault !== 'none'
            ? current.delivery.fault
            : 'acknowledged';
      expected.push({
        deliveryId: current.delivery.id,
        attempt: current.attempt,
        timeMs: current.timeMs,
        transport,
      });
      if (transport !== 'acknowledged' && current.attempt < 3)
        pending.push({
          delivery: current.delivery,
          ordinal: ordinal++,
          attempt: current.attempt + 1,
          timeMs: current.timeMs + current.attempt * 1000,
        });
    }
    for (const strategy of replayScenario(scenario).strategies) {
      expect(
        strategy.attempts.map(({ deliveryId, attempt, timeMs, transport }) => ({
          deliveryId,
          attempt,
          timeMs,
          transport,
        })),
        `${scenario.id}/${strategy.id}`,
      ).toEqual(expected);
    }
  }
});
