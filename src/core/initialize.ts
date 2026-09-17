import { createReplay } from './replay';
import type { Fault, OrderEvent, Scenario } from './schema';

/** Exercise bounded validation and replay paths before the Worker request CPU budget. */
export function initializeReplay(): void {
  const id = (prefix: string, index: number) => `${prefix}${String(index).padStart(63, '0')}`;
  const events: OrderEvent[] = Array.from({ length: 50 }, (_, index) => ({
    recordId: id('r', index),
    eventId: id('e', index),
    orderId: id('o', index < 8 ? 0 : index),
    revision: Number.MAX_SAFE_INTEGER,
    status: 'paid',
    totalCents: Number.MAX_SAFE_INTEGER,
    occurredAt: '2026-09-17T00:00:00.123Z',
  }));
  Object.assign(events[0], { revision: 5, status: 'paid' });
  Object.assign(events[1], { revision: 3, status: 'created' });
  Object.assign(events[2], {
    revision: 5,
    status: 'paid',
    occurredAt: '2026-09-17T01:00:00.123+01:00',
  });
  Object.assign(events[3], { revision: 5, status: 'cancelled' });
  Object.assign(events[4], { revision: 6, status: 'shipped', eventId: events[0].eventId });
  Object.assign(events[5], { status: 'shipped' });
  Object.assign(events[6], { revision: 3, status: 'refunded' });
  Object.assign(events[7], { status: 'shipped' });

  const initialFaults: Fault[] = [
    'timeout-after',
    'none',
    'none',
    'timeout-after',
    'none',
    'none',
    'none',
    'none',
    'timeout-before',
    'unavailable',
  ];
  const laterFaults: Fault[] = ['none', 'timeout-before', 'timeout-after', 'unavailable'];
  const input: Scenario = {
    schemaVersion: 1,
    id: 'replay-initialization',
    title: 'Replay initialization',
    origin: 'fixture',
    events,
    deliveries: Array.from({ length: 100 }, (_, index) => ({
      id: id('d', index),
      recordId: events[index % events.length].recordId,
      atMs: index,
      fault:
        index < initialFaults.length
          ? initialFaults[index]
          : laterFaults[index % laterFaults.length],
    })),
  };
  const serializedInput = JSON.stringify(input);
  const encoder = new TextEncoder();
  // The seed is synthetic and fixed. Every result is discarded; no input or result is cached.
  for (let iteration = 0; iteration < 10; iteration++) {
    const { scenario, result } = createReplay(JSON.parse(serializedInput) as unknown);
    encoder.encode(JSON.stringify(scenario));
    encoder.encode(JSON.stringify(result));
  }
}
