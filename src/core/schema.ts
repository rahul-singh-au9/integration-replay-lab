import { z } from 'zod';

export const MAX_SCENARIO_BYTES = 64 * 1024;
export const MAX_EVENTS = 50;
export const MAX_DELIVERIES = 100;

const identifier = z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/, 'Use a simple, nonempty identifier.');
const eventSchema = z.strictObject({
  recordId: identifier,
  eventId: identifier,
  orderId: identifier,
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  status: z.enum(['created', 'paid', 'shipped', 'cancelled', 'refunded']),
  totalCents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  occurredAt: z.string().datetime({ offset: true }),
});

const deliverySchema = z.strictObject({
  id: identifier,
  recordId: identifier,
  atMs: z.number().int().min(0).max(86_400_000),
  fault: z.enum(['none', 'timeout-before', 'timeout-after', 'unavailable']),
});

const scenarioSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: identifier,
  title: z.string().min(1).max(160).refine((value) => value.trim().length > 0, 'Must not be blank.'),
  origin: z.enum(['fixture', 'imported']),
  events: z.array(eventSchema).min(1).max(MAX_EVENTS),
  deliveries: z.array(deliverySchema).min(1).max(MAX_DELIVERIES),
});

export type Scenario = z.infer<typeof scenarioSchema>;
export type OrderEvent = z.infer<typeof eventSchema>;
export type Delivery = z.infer<typeof deliverySchema>;
export type Fault = Delivery['fault'];
export type OrderStatus = OrderEvent['status'];

function checkSize(text: string): void {
  if (new TextEncoder().encode(text).byteLength > MAX_SCENARIO_BYTES) {
    throw new Error('Scenario exceeds the 64 KiB limit. Import a smaller scenario.');
  }
}

export function parseScenario(input: unknown): Scenario {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(input);
  } catch {
    throw new Error('Scenario must be a JSON object without circular values.');
  }
  if (serialized === undefined) throw new Error('Scenario must be a JSON object.');
  checkSize(serialized);
  const result = scenarioSchema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue.path.length ? issue.path.join('.') : 'scenario';
    throw new Error(`${path}: ${issue.message}`);
  }

  const scenario = result.data;
  const recordIds = new Set<string>();
  for (const event of scenario.events) {
    if (recordIds.has(event.recordId)) throw new Error(`Duplicate record ID: ${event.recordId}. Use separate record IDs to test an event-ID collision.`);
    recordIds.add(event.recordId);
  }
  const deliveryIds = new Set<string>();
  for (const delivery of scenario.deliveries) {
    if (deliveryIds.has(delivery.id)) throw new Error(`Duplicate delivery ID: ${delivery.id}.`);
    if (!recordIds.has(delivery.recordId)) throw new Error(`Delivery ${delivery.id} references unknown record: ${delivery.recordId}.`);
    deliveryIds.add(delivery.id);
  }
  return scenario;
}

/** Accepts a raw scenario. Report-bundle importers should extract its scenario first. */
export function parseScenarioText(text: string): Scenario {
  checkSize(text);
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    throw new Error('Invalid JSON. Import a raw scenario JSON file.');
  }
  return parseScenario(input);
}
