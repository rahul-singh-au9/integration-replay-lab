# Verification record

Date: 2026-09-17. Environment: Node 24.21.0, TypeScript 6.0.3, Playwright 1.63.0, Wrangler 4.133.0. Local testing used macOS ARM64 and isolated Worker/D1 instances. Public verification uses the owned HTTPS deployment and synthetic records only.

The full-stack application is deployed at [Integration Replay Lab](https://integration-replay-lab.rahulsg1508.workers.dev). Functional and security checks pass within the documented scope. Live CPU spikes remain an operational limitation: this record does not claim that every request stays below the Workers Free 10 ms allowance.

## Executed local checks

| Check                                         | Result                                                         |
| --------------------------------------------- | -------------------------------------------------------------- |
| Typed lint, formatting and strict TypeScript  | Passed                                                         |
| Unit/API/client/import tests                  | 158 passed: 40 core, 82 API, 36 client/import                  |
| Production frontend and CLI builds            | Passed                                                         |
| CLI process tests                             | 9 passed                                                       |
| Browser journeys                              | 42 passed: 14 each in Chromium, Firefox and WebKit; no retries |
| Dependency audit                              | 0 known vulnerabilities reported at check time                 |
| Local D1 migrations                           | Both applied successfully                                      |
| Isolated backup/restore and scheduled cleanup | Passed                                                         |
| Desktop/mobile recordings                     | Recorded, encoded, decoded and playback-checked                |

Coverage reporting for the selected core, API/client and Worker modules measured **98.86% lines, 98.32% statements, 95.66% branches and 100% functions**. This is not whole-application coverage: React components, CLI process code, fixtures and verification scripts are outside the configured coverage scope. Browser and process tests exercise those paths separately; no percentage proves absence of defects.

Core tests inspect snapshots, effects, attempts and dead letters for duplicate delivery, acknowledgement loss, stale revisions, conflicting identities, contradictory revisions, retry exhaustion, deterministic ordering and strict input bounds. Timestamp precision is bounded so canonicalization cannot silently discard submillisecond identity differences.

API tests execute SQL statements and migration triggers in SQLite. They cover owner isolation, cookie attributes, origin/fetch-metadata defenses, route/method responses, malformed and streaming input, byte/capacity limits, expired rows, storage failures, corrupt or unsupported saved results and safely escaped response serialization. The server recomputes replay results rather than trusting uploaded results. Browser journeys separately verify actual Worker/D1 bindings.

Client/import tests cover successful-response validation, request deadlines, session coordination, malformed UTF-8 and bundles, and stale asynchronous responses. CLI tests launch the built executable and verify output/exit status, conflicts, dead letters, bounded regular-file reads, invalid encodings and refusal to read a named pipe.

Browser journeys verify server replay → export → local comparison → reload → open → delete, plus cross-session isolation. A larger-scenario journey verifies that the save action is disabled with a clear 20-snapshot/40-delivery explanation, while local replay/export remain available and no save request is sent. Other journeys cover malformed input, unavailable storage, distinct unsaved local results, keyboard dialogs, mobile navigation, racing selections and inert imported markup. A real WebKit focus-return defect was corrected by preserving the opening button explicitly.

Automated axe checks found no serious or critical violations in the tested replay, method, JSON and import views. Manual desktop/mobile inspection covered hierarchy, wrapping, controls and error states. Tested long identifiers and maximum amounts do not overflow the 320 px layout. These checks do not constitute a comprehensive accessibility certification, screen-reader study or physical-device test.

## Local performance

A 50-event, 100-delivery scenario with 64-character identifiers and maximum safe integer values used 35,728 input bytes. The last uninstrumented check measured median replay **0.950 ms** and saved-result verification **0.769 ms** over 15 runs. Mixed faults produced 364,594 output bytes and 500 combined attempts; permanent failures produced 378,338 bytes and 600 combined attempts. The API independently enforces its 512 KiB result bound; these examples do not prove the largest possible serialization.

Frontend JavaScript and CSS measured **approximately 112 KiB gzip**, below the 250 KiB target. Browser usability checks completed in 578–585 ms, including a 500 ms observation interval, without third-party requests. This is a local smoke measurement rather than a mobile-network or Core Web Vitals result.

The Worker initializes its bounded validation/replay paths with fixed synthetic inputs before handling requests. Fresh-process local measurements improved the first maximum replay from 4.89–7.86 ms to 1.79–2.20 ms, with 18–21 ms startup initialization. The API also reuses safely serialized scenario/results when constructing responses. Neither optimization changes validation or scenario limits; cloud CPU must still be measured independently.

## Recovery and retention

The isolated local recovery rehearsal applied both migrations, exported and restored into a separate empty persistence directory, and compared content digests, three indexes and four triggers. A fresh run created through the actual Worker persisted a 163-byte result fingerprint envelope. Both that compact run and a legacy full-result run reopened with exact scenario/results; expired and foreign-owner reads returned 404. UTF-8 insert/update guards rejected oversized storage. Capacity moved 3 → 4 → 3, then repeated actual scheduled-handler calls removed only the expired record, leaving two. Stored legacy and fingerprint representations were unchanged after reading. The source database remained unchanged.

Actual remote scheduling also passed: an every-minute verification trigger registered at 09:39:33 UTC removed only the expired synthetic record, observed at 09:44:11 UTC. The daily 03:17 UTC schedule was restored at 09:44:18 UTC, and both owned synthetic IDs were absent after cleanup at 09:44:25 UTC. A preceding seven-minute attempt had not observed execution and was safely restored/cleaned; it was not counted as a pass. This does not claim a production disaster-recovery exercise or remote Time Travel restore.

## Walkthrough recordings

- Desktop: 2 minutes 41.80 seconds, 1440 × 1100 including captions, 14 chapters.
- Mobile: 37.36 seconds, 390 × 944 including captions, four chapters.

The continuous browser recordings show fixtures, both consumers, attempt/state/effect evidence, custom conflicts and multiple orders, JSON edit/import/export, actual local D1 save/reload/open/delete, invalid input, method documentation and mobile navigation. The injected 503 demonstration is labelled explicitly. Both runs completed without page errors. MP4 decode, browser playback/seek and byte-range serving passed. Original recordings, captions, chapter data and review frames remain in the ignored local `.artifacts/walkthrough` directory.

These are functional demonstrations recorded after implementation. The [build journal](BUILD_JOURNAL.md) records the construction and review steps; the videos are not a continuous historical recording of every edit.

## Public verification and release status

The initial Worker version was `4e039a2b-f713-4dc1-9c72-dcd253c07b47`. A separate real D1 database, both migrations and native write limiter were deployed successfully in the already verified Workers Free account, without a plan upgrade.

The initial live stress run submitted three maximum-collection cases: mixed faults, permanent unavailability and lost acknowledgements. All saves returned 201, all reads returned 200, and full results matched the built CLI. All three owned synthetic records were removed. Observed CPU was 17–38 ms, above the 10 ms Free allowance despite successful responses. Startup initialization, encoded-response reuse, stable heap scheduling and compact fingerprint storage reduced repeated work. Larger local scenarios retain support, while new server saves are explicitly capped at 20 events and 40 deliveries.

The final deployed version is `c8d81461-7fe0-43e3-96c8-603b9c6d419c`, with 67 ms startup. The actual D1 and native limiter bindings were verified through deployed version metadata; the all-zero local preview identifier is not the production binding.

All three server-maximum cases (20 event records, 40 deliveries) saved and reopened with complete results equal to the built CLI. Input sizes were 14,425–14,501 bytes; output sizes were 141,231–152,233 bytes; combined attempt counts were 200, 240 and 160. All three owned records were removed. CPU for these six saves/reads measured **4–20 ms**, including three observations above 10 ms, without a failed HTTP request or exceeded-CPU outcome. The previous revision also had a 17 ms observation. Thus maximum-size functional checks passed, but strict per-request Free-plan CPU headroom is **not established**. Cloudflare documents [limited tolerance for infrequent CPU overages](https://developers.cloudflare.com/workers/platform/limits/#cpu-time); do not rely on it as guaranteed capacity. Monitor exceeded-CPU outcomes and retain local replay/export when hosted saving fails.

The final optimization reuses canonical timestamps and semantic fingerprints only within one replay, with independent consumer state and returned objects. Timestamp conversions in the 20/40 timeout case dropped from 180 to 20; mixed faults dropped from 90 to 10, and unavailable records still require none. Golden results and a cross-replay mutation-isolation regression passed. Local profiling improved the timeout case, but it did not eliminate the measured cloud variability.

Forty-two public browser journeys passed without retries across Chromium, Firefox and WebKit on version `b8d57adb`, including actual D1 persistence, isolation, deletion and secure cookie checks. The final revision retains those replay outputs; its changed import-message flow passed three additional focused checks across the same engines, including the disabled-save explanation, local/export operation and 320 px layout. These focused checks stubbed the API and sent no real writes. Public usability observations were 1.86–2.19 seconds including a 500 ms idle observation; these are bounded smoke checks, not a global latency guarantee. Failure-injection/client-race journeys use controlled API responses; the primary persistence journey uses the real server.

Final live API smoke checks passed for database health, restrictive static/API headers, anonymous access rejection, cross-origin rejection and correct 404/405 behavior. Invalid-mode checks rejected excessive collections and bytes with 413, rejected a malformed record with 400, and confirmed no run was stored. Locally valid 21-event and 41-delivery scenarios remained usable through the CLI but were rejected for saving. A bounded rate-limit check observed a real 429 with Retry-After: 60 and stopped immediately. After more than 61 seconds, a new maximum-scenario round passed all three create/read/delete sequences, confirming write recovery. All owned synthetic records were removed. This recovery round measured 2–17 ms CPU for its six save/read requests, including one 17 ms read, so the performance qualification still applies.

The repository is published at [rahul-singh-au9/integration-replay-lab](https://github.com/rahul-singh-au9/integration-replay-lab). [Hosted CI for revision 4f416d6](https://github.com/rahul-singh-au9/integration-replay-lab/actions/runs/35206468889) passed 157 unit/API/client/import tests, nine CLI tests and 42 browser journeys. The final code adds one isolation regression (158 focused tests total), reuses per-record canonical strings and corrects import guidance. The [main branch verification history](https://github.com/rahul-singh-au9/integration-replay-lab/actions/workflows/verify.yml?query=branch%3Amain) provides the final source revision and hosted status. All final engineering checks, browser counts and deployment evidence are distinguished above.

## Interpretation limits

This release simulates delivery of complete order snapshots. Consumer decisions are modeled in memory; D1 stores replay artifacts rather than real business transactions. It does not dispatch webhooks, process payments or establish exactly-once behavior across distributed systems. Concurrent consumers, dedupe expiry and retry exhaustion after an earlier committed effect are outside the current model. Cookie loss loses saved-run access. Anonymous traffic can exhaust shared hosting quotas. See the scenario format, threat model and operations guide for details.
