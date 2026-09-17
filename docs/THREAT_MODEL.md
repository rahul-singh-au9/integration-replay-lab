# Threat model

## Purpose and boundaries

Integration Replay Lab is a deterministic experiment for receiving complete order snapshots under duplicate delivery, reordering, pre-commit failures, lost acknowledgements, and bounded retries. It compares processing strategies inside a finite simulation. It does not receive production webhooks, connect to a merchant or payment provider, call external URLs, execute imported code, or move money.

The browser can compute a replay locally. The Worker repeats schema validation and computes the result itself before saving a scenario/result pair to D1. D1 persistence is real; the business processors, delivery queue, failure outcomes, acknowledgements, and clock represented in a result are simulated. Logical retry delays are not measured network latency or throughput.

An import's title, source label, event identifiers, revisions, snapshots, and failure plan are untrusted assertions. A valid schema establishes format, not provenance or truth. Bundled fixtures must remain labeled synthetic. An imported scenario is not proof that the represented failure occurred in a real system.

## Delivery semantics and invariants

An event ID identifies a logical message. An order ID identifies a business resource. A source revision identifies that order's snapshot version. A record ID identifies one input record, allowing conflicting records to deliberately reuse an event ID. A delivery ID identifies one authored transmission plan; its automatic attempts preserve that delivery and event identity. These identities are not interchangeable.

Semantic equality compares order ID, revision, status, total cents, and the source timestamp normalized to UTC. It excludes record IDs and delivery scheduling details. Equivalent timestamp encodings compare equally; different instants are different content under this contract. Event IDs share one namespace across the scenario, while revisions are scoped to an order.

The guarded processor's intended invariants are:

| Situation                                                    | Required interpretation                                                                                                                                                               |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Same event ID, same business payload                         | A retry/duplicate must not apply the business effect twice.                                                                                                                           |
| Same event ID, different business payload                    | Conflicting reuse of an idempotency key must be quarantined or rejected, never silently treated as equivalent.                                                                        |
| Same order and revision, different event IDs, equal snapshot | A semantically redundant snapshot must not create another business effect.                                                                                                            |
| Same order and revision, different snapshot                  | A source-version conflict must be quarantined or rejected. A new event ID does not make it a valid newer state.                                                                       |
| Lower source revision arrives after a higher revision        | The projection must not regress. Acknowledging a stale message does not mean applying it.                                                                                             |
| Higher source revision skips intermediate revisions          | Gaps are permitted because every event contains a complete snapshot. The experiment does not support delta events or reconstruct omitted transitions.                                 |
| Failure before commit                                        | No modeled business state or committed idempotency record has changed.                                                                                                                |
| Failure after commit but before acknowledgement              | State may already be changed even though delivery appears unsuccessful. Retrying preserves the same logical event ID.                                                                 |
| Retry budget exhausted                                       | The current model exhausts only permanently unavailable deliveries, which never reach the consumer. More general real-world exhaustion would not itself prove that nothing committed. |

Idempotency is not ordering: remembering one event ID cannot prevent a different older event from regressing an order. Ordering is not idempotency: a version comparison alone may hide a reused event ID with conflicting intent. A higher snapshot revision may also change status or amounts in either direction; this lab does not assert a universal commerce status transition graph.

Production implementations would need atomic coordination of the idempotency record and business mutation, an explicit key-retention policy, authentication of the sender, and a source contract for comparable versions. Here the processor state is modeled synchronously in memory for one run. D1 stores the completed experiment; it is not the transactional database of the simulated order processor. The experiment does not test crashes between real transaction statements, concurrent workers, database isolation, or distributed consensus.

The simulator processes attempts by ascending scheduled logical time, then by enqueue ordinal. Initial equal-time deliveries retain their array order and precede retries appended later for that same time. Retry delays are one second after the first attempt and two seconds after the second, with three attempts at most. `timeout-before` and `timeout-after` affect only the first attempt; the next attempt is acknowledged. `unavailable` fails every attempt and reaches the simulated dead-letter queue. There is no per-attempt fault sequence, jitter, wall-clock waiting, or delivery-plan randomness. Up to 50 records and 100 authored deliveries allow at most 300 attempts per strategy.

A conflict produces a quarantined decision in the attempt log without a business effect. It is acknowledged unless the authored transport fault loses that acknowledgement; it is not automatically added to a separate durable quarantine queue. Side effects and dead letters are entries in the result, not external messages or independently running queues.

Replays must produce the same result for the same normalized scenario, including ties. This tie order is an experiment rule, not an assertion about real delivery order. Message creation timestamps cannot substitute for a trustworthy source revision. Exhaustion after repeated lost acknowledgements is outside the current fault vocabulary; adding it would require tests that distinguish committed state from unresolved delivery.

These distinctions follow general delivery guidance: [Stripe documents unordered and duplicate webhook delivery](https://docs.stripe.com/webhooks), while [AWS describes stable request identifiers, parameter mismatch checks, and atomic idempotency bookkeeping](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/). [Stripe's idempotent-request contract](https://docs.stripe.com/api/idempotent_requests) also illustrates why parameter comparison and key retention matter. These references motivate the design; the lab's custom snapshot schema does not implement either provider's API contract.

## Data flow and trust boundaries

1. The browser loads assets and synthetic examples.
2. An example or imported JSON is validated and replayed in browser memory. Imported text and URLs remain data. There is no localStorage run database; a page reload loses unsaved browser state.
3. Explicit server saving sends a scenario to the same-origin API. The client cannot submit a trusted precomputed result or owner identifier.
4. The API repeats validation, computes the result, derives owner scope from the anonymous session cookie, and persists the run.
5. Owner-scoped list/read/delete queries expose only the corresponding unexpired records. List metadata is checked before being returned. A detail read validates the stored scenario, recomputes the deterministic replay with the supported engine, and checks the cached canonical result and scenario metadata before returning them.
6. Export writes readable JSON for the visitor. Import restores content, not ownership credentials or the identity of the original source.

No replay attempt performs network I/O to a supplied destination. Adding real webhook intake, API connectors, queue workers, model calls, or arbitrary code execution requires a new threat review and data disclosure.

## Assets, controls, and residual risks

Protected assets include scenarios/results, anonymous session credentials, owner isolation, replay correctness, bounded database storage, and availability within the Free plan. Potential adversaries include malicious import authors, hostile websites, crafted HTTP clients, credential thieves, and automated request/storage abusers.

The operator and Cloudflare are trusted to administer deployment and storage. Data is not hidden from them. The design does not protect against a compromised user device, malicious browser extension, compromised build pipeline, or malicious operator.

| Threat                                    | Control                                                                                                                                                                                        | Remaining limitation                                                                                                                                                                                                |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reading/deleting another workspace's run  | Random 32-byte cookie, hashed owner identifier, and owner scope on every record query                                                                                                          | A stolen cookie grants that workspace's access. A run ID alone is insufficient.                                                                                                                                     |
| Cookie exposure                           | Production `__Host-irl_session`, `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`; no credential in URLs, exports, or frontend storage                                                        | Script already running on the origin can act as the visitor even without reading the cookie.                                                                                                                        |
| Cross-site writes                         | Exact `Origin` check, rejection of `Sec-Fetch-Site: cross-site`, JSON-only POSTs, same-origin frontend/API                                                                                     | Non-browser attackers can supply headers and create their own sessions; these checks are not identity verification.                                                                                                 |
| Corrupt or incompatible saved conclusions | Revalidate the stored scenario, recompute its result, and compare the entire canonical result plus title, origin, and event count; return a generic storage error on mismatch                  | This detects accidental storage or version inconsistencies, not a malicious operator who can replace both the scenario and its result. Engine changes require an explicit compatibility or data migration decision. |
| Script/SQL injection                      | Render imported strings as text, restrictive CSP, no dynamic execution, bound SQL parameters, strict allowlisted schema                                                                        | A compromised dependency or deployment can undermine these controls.                                                                                                                                                |
| Replay/storage exhaustion                 | Streamed UTF-8 byte limit, bounded scenario structure/attempt counts, 1 KiB empty session requests, server result limit, database byte-bound triggers, atomic 20-owner/500-global storage caps | Byte caps do not alone establish CPU headroom. Session rotation and save/delete churn can exhaust provider quotas.                                                                                                  |
| Rate-limit bypass                         | Required mutation limiter, fail-closed errors, separate namespace, exact D1 storage checks                                                                                                     | Edge counters are approximate and regional; shared IPs can cause false positives and IP rotation can bypass them.                                                                                                   |
| Misleading results                        | Label simulation/provenance, separate attempts from applied changes, expose conflicts and unresolved deliveries, use logical-time labels                                                       | Authored examples do not establish real incident prevalence, end-to-end exactly-once guarantees, or production performance.                                                                                         |
| Sensitive upload                          | Explicit save action, local replay/export option, no body logging, instruction to sanitize first                                                                                               | Schema validation does not find every secret, personal detail, or proprietary payload.                                                                                                                              |
| Retention mismatch                        | Immediate read-time expiry and daily deletion with counter triggers                                                                                                                            | Cleanup may be delayed. Recovery history and exported copies have separate lifetimes.                                                                                                                               |

Unknown routes and unsupported methods are rejected before touching storage or consuming mutation quota. Unsupported methods include the route-specific `Allow` header. Private JSON responses use `no-store`, same-origin resource policy, anti-framing headers, a restrictive CSP, and HTTPS transport security. Request IDs support diagnosis without logging request bodies, cookies, owner identifiers, cached results, or database error messages.

These are release requirements; listing a control is not proof that a deployed service has been verified.

## Session and data lifecycle

The anonymous cookie is a bearer capability, not a verified account. Losing it loses access; there is no identity recovery. Export/import restores the content into another workspace without restoring the previous credential. Sharing an export shares its contents.

A cached result is bound to its scenario and engine version. An incompatible or damaged run fails closed on read; reading it never rewrites historical results. The owner can still delete the row, and an existing scenario export can be imported and replayed afresh. A future engine upgrade must explicitly preserve supported results or migrate affected data.

Saved runs expire 30 days after creation, with cleanup and recovery caveats documented in [Operations](OPERATIONS.md). Deleting a run cannot delete a visitor's exported copy. Simulated idempotency state is rebuilt for every replay; it is not retained as a production processing ledger.

## Meaningful release tests

- Retry after commit with lost acknowledgement: state changes once, event identity remains stable, and later acknowledgement does not produce another effect.
- Exhaust permanent unavailability: verify three attempts, no consumer receipt, and a simulated dead letter. If repeated lost acknowledgements are introduced later, also test exhaustion after a committed effect.
- Exercise changed payload under the same event ID, changed snapshot under the same order/revision with a different event ID, and equal snapshots with different IDs.
- Reorder revisions, including gaps and tied scheduling times; assert deterministic tie handling and that guarded state never regresses.
- Retry a lower revision after a higher one arrives. Distinguish acknowledged stale/duplicate processing from a newly applied change.
- Verify failure-before-commit does not consume a business effect or create a false successful idempotency entry.
- Re-run exported/imported scenarios and compare normalized results. Reject unsupported schema, unknown keys, non-finite values, excessive depth/counts, and excessive UTF-8 bytes.
- Use HTML/script, SQL-like strings, URL text, and prototype-related keys as hostile input; ensure inert rendering and no prototype modification.
- Create separate cookie jars and test foreign known IDs, list/read/delete isolation, malformed and duplicate cookies, missing Origin, cross-site headers, and unsupported content types.
- Stream an oversized multibyte body without trusting Content-Length; test malformed UTF-8 and output-size rejection with no insertion.
- Race saves at per-owner and global limits; verify counters after deletion and scheduled expiry, including exact expiry boundaries.
- Tamper with cached decisions, metrics, warnings, engine versions, scenario data, and list metadata; reject inconsistent artifacts without disclosing their contents or blocking owner-scoped deletion.
- Force limiter, database, request-stream, and unexpected replay failures; require private errors, no partial insertions, and continued local replay/export.

Use local bindings and synthetic scenarios for adversarial tests. Do not exhaust public provider quotas as a substitute for bounded local tests.
