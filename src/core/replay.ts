import { parseScenario, type Delivery, type OrderEvent, type OrderStatus, type Scenario } from './schema';

export const MAX_ATTEMPTS = 3;
export const RETRY_DELAYS_MS = [1000, 2000] as const;
export type StrategyId = 'naive' | 'robust';
export type ConsumerDecision = 'applied' | 'duplicate' | 'stale' | 'conflict' | 'not-received';
export type TransportOutcome = 'acknowledged' | 'timeout-before' | 'timeout-after' | 'unavailable';

export interface DeliveryAttempt {
  deliveryId: string;
  recordId: string;
  eventId: string;
  orderId: string;
  revision: number;
  attempt: number;
  timeMs: number;
  transport: TransportOutcome;
  decision: ConsumerDecision;
  reason: string;
}

export interface OrderSnapshot {
  orderId: string;
  revision: number;
  status: OrderStatus;
  totalCents: number;
  occurredAt: string;
  eventId: string;
  recordId: string;
}

export interface SimulatedEffect {
  key: string;
  deliveryId: string;
  eventId: string;
  orderId: string;
  revision: number;
  status: OrderStatus;
  timeMs: number;
}

export interface DeadLetter {
  deliveryId: string;
  recordId: string;
  eventId: string;
  attempts: number;
  lastTimeMs: number;
  reason: string;
}

export interface ReplayMetrics {
  received: number;
  attempts: number;
  applied: number;
  duplicates: number;
  stale: number;
  conflicts: number;
  deadLetters: number;
  sideEffects: number;
  duplicateEffects: number;
}

export interface StrategyResult {
  id: StrategyId;
  name: string;
  attempts: DeliveryAttempt[];
  finalOrders: OrderSnapshot[];
  effects: SimulatedEffect[];
  deadLetters: DeadLetter[];
  metrics: ReplayMetrics;
}

export interface ReplayResult {
  schemaVersion: 1;
  engineVersion: '1.0.0';
  scenarioId: string;
  scenarioTitle: string;
  origin: Scenario['origin'];
  mode: 'simulation';
  strategies: StrategyResult[];
  warnings: string[];
}

interface ScheduledAttempt {
  delivery: Delivery;
  attempt: number;
  timeMs: number;
  ordinal: number;
}

type Disposition = { decision: Exclude<ConsumerDecision, 'not-received'>; reason: string };

/** Fixed field order gives semantic equality without a collision-prone short hash. */
function fingerprint(event: OrderEvent): string {
  return JSON.stringify([event.orderId, event.revision, event.status, event.totalCents, new Date(event.occurredAt).toISOString()]);
}

function snapshot(event: OrderEvent): OrderSnapshot {
  return {
    orderId: event.orderId, revision: event.revision, status: event.status,
    totalCents: event.totalCents, occurredAt: new Date(event.occurredAt).toISOString(),
    eventId: event.eventId, recordId: event.recordId,
  };
}

function runStrategy(scenario: Scenario, strategy: StrategyId): StrategyResult {
  const records = new Map(scenario.events.map((event) => [event.recordId, event]));
  const orders = new Map<string, OrderSnapshot>();
  const seenEvents = new Map<string, string>();
  const seenRevisions = new Map<string, Map<number, string>>();
  const effectKeys = new Set<string>();
  const effects: SimulatedEffect[] = [];
  const attempts: DeliveryAttempt[] = [];
  const deadLetters: DeadLetter[] = [];
  const metrics: ReplayMetrics = { received: 0, attempts: 0, applied: 0, duplicates: 0, stale: 0, conflicts: 0, deadLetters: 0, sideEffects: 0, duplicateEffects: 0 };
  const queue: ScheduledAttempt[] = scenario.deliveries.map((delivery, ordinal) => ({ delivery, ordinal, attempt: 1, timeMs: delivery.atMs }));
  let nextOrdinal = queue.length;

  function consume(event: OrderEvent, scheduled: ScheduledAttempt): Disposition {
    if (strategy === 'robust') {
      const content = fingerprint(event);
      const knownEvent = seenEvents.get(event.eventId);
      if (knownEvent !== undefined && knownEvent !== content) {
        return { decision: 'conflict', reason: 'Quarantined: this event ID was already received with different semantic content.' };
      }
      seenEvents.set(event.eventId, content);
      const revisions = seenRevisions.get(event.orderId) ?? new Map<number, string>();
      const knownRevision = revisions.get(event.revision);
      if (knownRevision !== undefined && knownRevision !== content) {
        return { decision: 'conflict', reason: 'Quarantined: the same order revision has conflicting snapshot content.' };
      }
      revisions.set(event.revision, content);
      seenRevisions.set(event.orderId, revisions);
      if (knownEvent !== undefined) {
        return { decision: 'duplicate', reason: 'Ignored: this event ID and semantic content were already received.' };
      }
      const current = orders.get(event.orderId);
      if (current && event.revision < current.revision) {
        return { decision: 'stale', reason: 'Ignored: this full snapshot is older than the current order revision.' };
      }
      if (current && event.revision === current.revision) {
        return { decision: 'duplicate', reason: 'Ignored: this identical order revision is already applied under another event ID.' };
      }
    }

    orders.set(event.orderId, snapshot(event));
    const effectKey = JSON.stringify([event.orderId, event.revision]);
    if (effectKeys.has(effectKey)) metrics.duplicateEffects++;
    effectKeys.add(effectKey);
    effects.push({ key: effectKey, deliveryId: scheduled.delivery.id, eventId: event.eventId, orderId: event.orderId, revision: event.revision, status: event.status, timeMs: scheduled.timeMs });
    return {
      decision: 'applied',
      reason: strategy === 'naive'
        ? 'Applied every received snapshot and emitted a simulated effect, without deduplication or revision checks.'
        : 'Applied a newer full snapshot and atomically recorded its single simulated outbox effect.',
    };
  }

  while (queue.length) {
    queue.sort((a, b) => a.timeMs - b.timeMs || a.ordinal - b.ordinal);
    const scheduled = queue.shift()!;
    const event = records.get(scheduled.delivery.recordId)!;
    const fault = scheduled.delivery.fault;
    const transport: TransportOutcome = fault === 'unavailable' ? 'unavailable'
      : scheduled.attempt === 1 && fault !== 'none' ? fault : 'acknowledged';
    let disposition: { decision: ConsumerDecision; reason: string };
    if (transport === 'timeout-before' || transport === 'unavailable') {
      disposition = { decision: 'not-received', reason: transport === 'unavailable' ? 'The simulated endpoint is unavailable; the consumer received nothing.' : 'The first attempt timed out before reaching the simulated consumer.' };
    } else {
      metrics.received++;
      disposition = consume(event, scheduled);
      if (disposition.decision === 'applied') metrics.applied++;
      else if (disposition.decision === 'duplicate') metrics.duplicates++;
      else if (disposition.decision === 'stale') metrics.stale++;
      else if (disposition.decision === 'conflict') metrics.conflicts++;
      if (transport === 'timeout-after') disposition.reason += ' Processing completed, but its acknowledgement was lost.';
    }
    attempts.push({
      deliveryId: scheduled.delivery.id, recordId: event.recordId, eventId: event.eventId,
      orderId: event.orderId, revision: event.revision, attempt: scheduled.attempt,
      timeMs: scheduled.timeMs, transport, ...disposition,
    });

    if (transport !== 'acknowledged') {
      if (scheduled.attempt < MAX_ATTEMPTS) {
        queue.push({ delivery: scheduled.delivery, attempt: scheduled.attempt + 1, timeMs: scheduled.timeMs + RETRY_DELAYS_MS[scheduled.attempt - 1], ordinal: nextOrdinal++ });
      } else {
        deadLetters.push({ deliveryId: scheduled.delivery.id, recordId: event.recordId, eventId: event.eventId, attempts: scheduled.attempt, lastTimeMs: scheduled.timeMs, reason: 'Retry limit reached without acknowledgement. This delivery was placed in the simulated dead-letter queue.' });
      }
    }
  }

  metrics.attempts = attempts.length;
  metrics.deadLetters = deadLetters.length;
  metrics.sideEffects = effects.length;
  return {
    id: strategy, name: strategy === 'naive' ? 'Apply every delivery' : 'Dedupe + revision guard',
    attempts, effects, deadLetters, metrics,
    finalOrders: [...orders.values()].sort((a, b) => a.orderId < b.orderId ? -1 : a.orderId > b.orderId ? 1 : 0),
  };
}

/** Runs both consumers on an identical virtual schedule, with no I/O or real waits. */
export function replayScenario(input: Scenario): ReplayResult {
  const scenario = parseScenario(input);
  return {
    schemaVersion: 1, engineVersion: '1.0.0', scenarioId: scenario.id, scenarioTitle: scenario.title,
    origin: scenario.origin, mode: 'simulation',
    strategies: [runStrategy(scenario, 'naive'), runStrategy(scenario, 'robust')],
    warnings: [
      'This is a deterministic delivery simulation. It makes no outbound requests and generates no real business effects.',
      'Events are complete order snapshots. Higher revisions may skip gaps; this model is not safe for deltas or missing incremental updates.',
      'The robust model assumes atomic state, dedupe and outbox writes. It does not test a real database, concurrent workers or an external connector.',
      'Faults and timestamps are supplied scenario inputs. Results are not production reliability measurements or proof of exactly-once external delivery.',
      ...(scenario.origin === 'fixture' ? ['This authored fixture illustrates a failure case; it is not a captured production incident.'] : []),
    ],
  };
}
