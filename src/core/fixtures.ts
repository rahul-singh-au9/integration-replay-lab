import { parseScenario, type OrderEvent, type Scenario } from './schema';

export interface Fixture {
  id: string;
  title: string;
  description: string;
  scenario: Scenario;
}

const created: OrderEvent = {
  recordId: 'snapshot-created',
  eventId: 'event-created',
  orderId: 'order-1042',
  revision: 1,
  status: 'created',
  totalCents: 12900,
  occurredAt: '2026-02-10T10:00:00Z',
};
const paid: OrderEvent = {
  recordId: 'snapshot-paid',
  eventId: 'event-paid',
  orderId: 'order-1042',
  revision: 2,
  status: 'paid',
  totalCents: 12900,
  occurredAt: '2026-02-10T10:01:00Z',
};

function fixture(
  id: string,
  title: string,
  description: string,
  events: OrderEvent[],
  deliveries: Scenario['deliveries'],
): Fixture {
  return {
    id,
    title,
    description,
    scenario: parseScenario({ schemaVersion: 1, id, title, origin: 'fixture', events, deliveries }),
  };
}

/** These are authored simulations, not external service traces or production incidents. */
export const fixtures: Fixture[] = [
  fixture(
    'duplicate-delivery',
    'The same event arrives twice',
    'Two separate deliveries carry the same paid-order snapshot. A consumer without deduplication emits the same logical effect twice.',
    [paid],
    [
      { id: 'delivery-1', recordId: paid.recordId, atMs: 0, fault: 'none' },
      { id: 'delivery-2', recordId: paid.recordId, atMs: 100, fault: 'none' },
    ],
  ),
  fixture(
    'out-of-order',
    'An older revision arrives late',
    'The paid snapshot arrives before the older created snapshot. Applying every delivery rolls the order back; the revision guard retains the paid state.',
    [created, paid],
    [
      { id: 'delivery-paid', recordId: paid.recordId, atMs: 0, fault: 'none' },
      { id: 'delivery-created', recordId: created.recordId, atMs: 100, fault: 'none' },
    ],
  ),
  fixture(
    'timeout-after-commit',
    'Commit succeeds, acknowledgement is lost',
    'The first attempt is processed but times out before the sender sees an acknowledgement. The retry repeats the effect unless the consumer deduplicates.',
    [paid],
    [{ id: 'delivery-1', recordId: paid.recordId, atMs: 0, fault: 'timeout-after' }],
  ),
  fixture(
    'permanent-failure',
    'Unavailable endpoint exhausts retries',
    'All three attempts fail before reaching the consumer. After virtual waits of one and two seconds, the delivery enters the simulated dead-letter queue.',
    [paid],
    [{ id: 'delivery-1', recordId: paid.recordId, atMs: 0, fault: 'unavailable' }],
  ),
];
