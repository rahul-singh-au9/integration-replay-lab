# Scenario format and simulation contract

Integration Replay Lab compares two in-memory consumers on the same deterministic webhook delivery schedule. It does not send network requests, contact a connector, wait in real time, or create external business effects. Results describe the supplied model and faults, not observed production reliability.

Saving on the hosted service supports at most **20 event records and 40 deliveries**. The scenario format itself supports **50 event records and 100 deliveries** for browser/CLI replay and export. Larger valid scenarios remain usable locally, with a clear explanation beside the disabled save action.

## Format and limits

Scenario schema and replay result schema are version `1`; the engine version is `1.0.0`.

| Field           | Meaning                                                                    |
| --------------- | -------------------------------------------------------------------------- |
| `schemaVersion` | Must be `1`                                                                |
| `id`            | Scenario identifier                                                        |
| `title`         | Nonblank title, at most 160 characters                                     |
| `origin`        | `fixture` for an authored example; `imported` for a user-supplied scenario |
| `events`        | Between 1 and 50 complete order snapshot records                           |
| `deliveries`    | Between 1 and 100 scheduled initial deliveries                             |

A raw scenario is limited to 65,536 UTF-8 bytes, including whitespace. `parseScenarioText(text)` accepts a raw scenario, not a report wrapper. A report importer should extract `scenario` and use `parseScenario(value)`, which also checks the object's serialized byte size.

The browser and CLI share the same bundle importer. An export wrapper must identify `format: "integration-replay-lab"`, `schemaVersion: 1`, a valid `exportedAt` timestamp and its `scenario`; only optional `engineVersion` and `result` fields are also accepted. Included results are ignored during import and recomputed when the scenario runs. A bundle is limited to 1 MiB, and its contained scenario retains the 64 KiB limit. The CLI reads only regular UTF-8 files and caps bytes while reading, including if a file grows after its initial size check.

Objects are strict: unknown fields, unknown fault types, unsupported statuses and prototype-related properties are rejected. IDs are nonempty, at most 64 characters, begin with a letter or digit, and otherwise contain letters, digits, `.`, `_`, `:`, `/`, or `-`. Collections are represented internally by maps rather than objects indexed by imported identifiers.

Collection lengths are rejected before validating individual entries, so a compact malformed array cannot trigger validation of thousands of records. Byte-limit failures are distinguishable from other scenario-validation failures without treating unexpected engine errors as invalid user input.

`origin: "imported"` does not establish that an input is a captured incident or that its claimed events happened. Neither input origin nor event identity is authenticated by the simulator.

## Order snapshot records

Every event record requires:

```ts
{
  recordId: string;
  eventId: string;
  orderId: string;
  revision: number;
  status: 'created' | 'paid' | 'shipped' | 'cancelled' | 'refunded';
  totalCents: number;
  occurredAt: string;
}
```

- `recordId` identifies this input record and must be unique within the scenario.
- `eventId` is the external idempotency key. It may appear in several records, including with changed content, so a scenario can test identity collisions. Event IDs are scoped to the whole scenario; there is no separate producer namespace.
- `orderId` identifies the order whose complete state the event represents.
- `revision` is a positive safe integer. The model trusts the producer's monotonic revision scheme; it does not infer versions from arrival time.
- `totalCents` is a nonnegative safe integer. It is an amount in cents with no currency field or conversion. The simulator compares and stores integer values; it performs no financial calculations.
- `occurredAt` is an ISO 8601 datetime with `Z` or an explicit UTC offset, at most 29 characters, and at most three fractional second digits. Submillisecond timestamps are rejected so distinct instants cannot silently collapse into the same identity. Equivalent instants are canonicalized to UTC at millisecond precision. Occurrence time is part of semantic payload identity, but it does not schedule delivery or override revision order.

These are **full snapshots**, not deltas. A consumer may accept revision 10 without first receiving revisions 3–9. That would be inappropriate for incremental balance updates or other deltas. The simulator also does not enforce a business status-transition graph: it assumes each producer-issued snapshot is the intended state for its revision.

## Scheduled deliveries and faults

Each delivery requires:

```ts
{
  id: string;
  recordId: string;
  atMs: number;
  fault: 'none' | 'timeout-before' | 'timeout-after' | 'unavailable';
}
```

Delivery IDs must be unique. `recordId` must reference an existing event record. `atMs` is an integer virtual time from 0 through 86,400,000 milliseconds. A retry may occur up to 3,000 milliseconds after that initial time. Scenario array order need not be chronological.

| Fault            | First attempt                                                           | Later attempts                                       |
| ---------------- | ----------------------------------------------------------------------- | ---------------------------------------------------- |
| `none`           | Consumer processes the event and the sender receives an acknowledgement | No retry                                             |
| `timeout-before` | Consumer receives nothing; the sender sees a timeout                    | Healthy retry                                        |
| `timeout-after`  | Consumer processes the event, but the acknowledgement is lost           | Healthy retry, including another consumer invocation |
| `unavailable`    | Consumer receives nothing                                               | Remains unavailable for all attempts                 |

Every delivery gets at most three attempts. After the first unacknowledged attempt, retry at `timeMs + 1000`; after the second, retry at `timeMs + 2000`. Thus a permanently unavailable delivery starting at zero has attempts at 0, 1000 and 3000 milliseconds. These are virtual schedule calculations, not real waits, and there is no jitter.

All original deliveries enter the queue first, in input-array order. Retries receive monotonically increasing queue ordinals when scheduled. The queue is ordered by `(timeMs, ordinal)`. Therefore an original delivery at 1000 ms runs before a retry subsequently scheduled for 1000 ms; retries tied with one another retain scheduling order. Both consumer strategies receive exactly this same transport schedule.

An acknowledgement only means the consumer's response reached the sender. It does not mean that an order snapshot was applied: duplicates, stale snapshots and quarantined conflicts are also terminally acknowledged in this model.

## Consumer strategies

### Apply every delivery

The naive strategy replaces the order state with every received snapshot and records one simulated effect for every invocation. It does not deduplicate, compare revisions or quarantine conflicts. Late older revisions can overwrite newer state, and repeat deliveries can emit duplicate logical effects.

### Dedupe + revision guard

The robust strategy maintains event-identity fingerprints, fingerprints for each observed order/revision, current order snapshots, and a simulated outbox.

A fingerprint is a canonical fixed-order representation of:

```text
[orderId, revision, status, totalCents, canonicalOccurredAt]
```

It excludes the internal `recordId`; `eventId` is the lookup key. The complete canonical representation is compared, rather than a shortened hash.

On each received event:

1. If its event ID was previously received with different semantic content, quarantine it.
2. Remember the first-seen event ID and content. This identity remains remembered even if a subsequent revision check quarantines the record.
3. If the same order/revision was already observed with different content, quarantine it. A retry of that conflicting payload remains a conflict.
4. Remember the first nonconflicting snapshot for this order/revision, even if it will be ignored as stale.
5. If the same event ID and content were already received, ignore the duplicate.
6. If its revision is older than the current order, ignore the stale snapshot.
7. If its revision equals the current order with identical content, ignore the duplicate even when it has a different event ID.
8. Otherwise, atomically model the newer order snapshot and one outbox effect for that order/revision.

Conflict checking precedes stale-event handling: an older conflicting snapshot is still reported as a conflict. A timeout before delivery does not touch any of these ledgers. A timeout after processing does not roll back the modeled state, identity records, or outbox.

The modeled transaction is an assumption, not an implemented order database transaction. There are no concurrent workers, transaction isolation tests, dedupe expiration, outbox-dispatch crashes or downstream idempotency failures in this version. Report persistence stores the scenario and its replay artifact; it does not turn the in-memory consumer into a production SQL order processor.

## Simulated effects, conflicts and dead letters

Each applied snapshot produces a generic simulated order-snapshot effect. It is not a payment, shipment, email or call to another system. The logical effect key is the canonical pair `[orderId, revision]`. The naive consumer may emit that key repeatedly; the robust consumer emits it at most once per replay.

A consumer `conflict` means the record was quarantined without changing order state or emitting an effect. Quarantine is represented by the decision and reason in the attempt trace; there is no external quarantine service. The sender receives an acknowledgement unless the supplied timeout-after fault loses that response.

Dead letters are separate: they represent deliveries that exhausted transport attempts without an acknowledgement. Under this narrow fault model, permanent `unavailable` deliveries never reach the consumer and may enter the dead-letter queue. Timeout-before and timeout-after faults clear after the first attempt, so they receive a response on their second attempt. A real system can exhaust retries after a prior commit; this simulator does not model that additional failure pattern.

## Result and metrics

`replayScenario(scenario)` returns `schemaVersion`, `engineVersion`, `scenarioId`, `scenarioTitle`, `origin`, `mode: "simulation"`, `strategies`, and `warnings`.

`createReplay(input)` validates once and returns both the accepted `scenario` and computed `result` for persistence. `parseSavedReplay(scenario, result)` checks a retrieved artifact against the complete deterministic result for the supported engine version before displaying it. It compares object properties without depending on their serialization order, while preserving array order, and rejects missing, extra or altered decisions, state, metrics and evidence. An unknown engine version is rejected explicitly; its scenario can still be imported and run to create a new result. This consistency check is not a signature or proof that an imported scenario describes real events.

Each strategy has `id` (`naive` or `robust`), `name`, `attempts`, `finalOrders`, `effects`, `deadLetters`, and `metrics`.

Attempt records separate transport and consumer disposition:

```ts
{
  deliveryId, recordId, eventId, orderId, revision,
  attempt, timeMs,
  transport: 'acknowledged' | 'timeout-before' | 'timeout-after' | 'unavailable',
  decision: 'applied' | 'duplicate' | 'stale' | 'conflict' | 'not-received',
  reason
}
```

Final orders include `orderId`, `revision`, `status`, `totalCents`, canonical `occurredAt`, `eventId`, and `recordId`, sorted by order ID. Effects contain their logical `key`, `deliveryId`, `eventId`, `orderId`, `revision`, `status`, and virtual `timeMs`. Dead letters contain `deliveryId`, `recordId`, `eventId`, attempt count, `lastTimeMs`, and a reason.

| Metric             | Counted unit                                                              |
| ------------------ | ------------------------------------------------------------------------- |
| `attempts`         | All initial and retry transport attempts                                  |
| `received`         | Consumer invocations, including duplicates, stale snapshots and conflicts |
| `applied`          | Invocations that changed modeled order state                              |
| `duplicates`       | Invocations discarded as duplicates                                       |
| `stale`            | Invocations discarded as older snapshots                                  |
| `conflicts`        | Invocations quarantined for identity or revision conflicts                |
| `deadLetters`      | Deliveries exhausted without acknowledgement                              |
| `sideEffects`      | Simulated outbox records emitted                                          |
| `duplicateEffects` | Emitted records whose logical effect key had already been emitted         |

These are counts, not inferred error rates. Conflict retries count as additional conflict invocations. A robust duplicate is successful suppression, while a duplicate effect is an unwanted repeat emission in the model. The same value must not be used for both concepts.

The bounds allow at most 300 attempts per strategy, or 600 combined attempts. Tests exercise long identifiers, maximum safe-integer revisions/amounts and both mixed and permanent-failure schedules, checking that replay JSON stays below 512 KiB. Local timing tests are regression checks, not measurements or guarantees of hosted CPU usage.

## Minimal duplicate-delivery example

This is an authored example. Both deliveries reference the same record:

```json
{
  "schemaVersion": 1,
  "id": "duplicate-example",
  "title": "A paid snapshot arrives twice",
  "origin": "fixture",
  "events": [
    {
      "recordId": "snapshot-1",
      "eventId": "payment-event-1",
      "orderId": "order-1",
      "revision": 2,
      "status": "paid",
      "totalCents": 12900,
      "occurredAt": "2026-02-10T10:01:00Z"
    }
  ],
  "deliveries": [
    { "id": "delivery-1", "recordId": "snapshot-1", "atMs": 0, "fault": "none" },
    { "id": "delivery-2", "recordId": "snapshot-1", "atMs": 100, "fault": "none" }
  ]
}
```

To test changed content under the same external event ID, add a second event with a new `recordId`, keep `eventId` unchanged, change a semantic field, then schedule that new record. To test revision conflicts under different event IDs, keep `orderId` and `revision` unchanged while changing both the event ID and semantic content.

All replay state starts empty. The engine uses no wall clock, randomness, remote response, dynamic code execution or real timers. Imported order identities, versions and statuses are scenario inputs, not independently verified business facts.
