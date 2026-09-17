# Verification record

Date: 2026-09-17. Environment: Node 24.21.0, TypeScript 6.0.3, Playwright 1.63.0, Wrangler 4.133.0. Local testing used macOS ARM64 and isolated Worker/D1 instances. Public verification uses the owned HTTPS deployment and synthetic records only.

The application is deployed at [Integration Replay Lab](https://integration-replay-lab.rahulsg1508.workers.dev). Release verification is in progress; the first live maximum-scenario check returned correct results but exceeded the Workers Free CPU allowance. Functional HTTP success alone is not a performance acceptance result.

## Executed local checks

| Check                                         | Result                                                         |
| --------------------------------------------- | -------------------------------------------------------------- |
| Typed lint, formatting and strict TypeScript  | Passed                                                         |
| Unit/API/client/import tests                  | 157 passed: 39 core, 82 API, 36 client/import                  |
| Production frontend and CLI builds            | Passed                                                         |
| CLI process tests                             | 9 passed                                                       |
| Browser journeys                              | 42 passed: 14 each in Chromium, Firefox and WebKit; no retries |
| Dependency audit                              | 0 known vulnerabilities reported at check time                 |
| Local D1 migrations                           | Both applied successfully                                      |
| Isolated backup/restore and scheduled cleanup | Passed                                                         |
| Desktop/mobile recordings                     | Recorded, encoded, decoded and playback-checked                |

Coverage reporting for the selected core, API/client and Worker modules measured **98.85% lines, 98.30% statements, 95.66% branches and 100% functions**. This is not whole-application coverage: React components, CLI process code, fixtures and verification scripts are outside the configured coverage scope. Browser and process tests exercise those paths separately; no percentage proves absence of defects.

Core tests inspect snapshots, effects, attempts and dead letters for duplicate delivery, acknowledgement loss, stale revisions, conflicting identities, contradictory revisions, retry exhaustion, deterministic ordering and strict input bounds. Timestamp precision is bounded so canonicalization cannot silently discard submillisecond identity differences.

API tests execute SQL statements and migration triggers in SQLite. They cover owner isolation, cookie attributes, origin/fetch-metadata defenses, route/method responses, malformed and streaming input, byte/capacity limits, expired rows, storage failures, corrupt or unsupported saved results and safely escaped response serialization. The server recomputes replay results rather than trusting uploaded results. Browser journeys separately verify actual Worker/D1 bindings.

Client/import tests cover successful-response validation, request deadlines, session coordination, malformed UTF-8 and bundles, and stale asynchronous responses. CLI tests launch the built executable and verify output/exit status, conflicts, dead letters, bounded regular-file reads, invalid encodings and refusal to read a named pipe.

Browser journeys verify server replay → export → local comparison → reload → open → delete, plus cross-session isolation. A larger-scenario journey verifies that the save action is disabled with a clear 20-snapshot/40-delivery explanation, while local replay/export remain available and no save request is sent. Other journeys cover malformed input, unavailable storage, distinct unsaved local results, keyboard dialogs, mobile navigation, racing selections and inert imported markup. A real WebKit focus-return defect was corrected by preserving the opening button explicitly.

Automated axe checks found no serious or critical violations in the tested replay, method, JSON and import views. Manual desktop/mobile inspection covered hierarchy, wrapping, controls and error states. Tested long identifiers and maximum amounts do not overflow the 320 px layout. These checks do not constitute a comprehensive accessibility certification, screen-reader study or physical-device test.

## Local performance

A 50-event, 100-delivery scenario with 64-character identifiers and maximum safe integer values used 35,728 input bytes. The last uninstrumented check measured median replay **0.480 ms** and saved-result verification **0.655 ms** over 15 runs. Mixed faults produced 364,594 output bytes and 500 combined attempts; permanent failures produced 378,338 bytes and 600 combined attempts. The API independently enforces its 512 KiB result bound; these examples do not prove the largest possible serialization.

Frontend JavaScript and CSS measured **111,479 bytes gzip**, below the 250 KiB target. Browser usability checks completed in 578–585 ms, including a 500 ms observation interval, without third-party requests. This is a local smoke measurement rather than a mobile-network or Core Web Vitals result.

The Worker initializes its bounded validation/replay paths with fixed synthetic inputs before handling requests. Fresh-process local measurements improved the first maximum replay from 4.89–7.86 ms to 1.79–2.20 ms, with 18–21 ms startup initialization. The API also reuses safely serialized scenario/results when constructing responses. Neither optimization changes validation or scenario limits; cloud CPU must still be measured independently.

## Recovery and retention

The isolated local recovery rehearsal applied both migrations, exported and restored into a separate empty persistence directory, and compared content digests, three indexes and four triggers. A fresh run created through the actual Worker persisted a 163-byte result fingerprint envelope. Both that compact run and a legacy full-result run reopened with exact scenario/results; expired and foreign-owner reads returned 404. UTF-8 insert/update guards rejected oversized storage. Capacity moved 3 → 4 → 3, then repeated actual scheduled-handler calls removed only the expired record, leaving two. Stored legacy and fingerprint representations were unchanged after reading. The source database remained unchanged.

This verifies local SQL backup/restore and scheduled-handler behavior. It does not claim a production disaster-recovery exercise or a remote Time Travel restore.

## Walkthrough recordings

- Desktop: 2 minutes 30.64 seconds, 1440 × 1100 including captions, 13 chapters.
- Mobile: 37.32 seconds, 390 × 944 including captions, four chapters.

The continuous browser recordings show fixtures, both consumers, attempt/state/effect evidence, custom conflicts and multiple orders, JSON edit/import/export, actual local D1 save/reload/open/delete, invalid input, method documentation and mobile navigation. The injected 503 demonstration is labelled explicitly. Both runs completed without page errors. MP4 decode, browser playback/seek and byte-range serving passed. Original recordings, captions, chapter data and review frames remain in the ignored local `.artifacts/walkthrough` directory.

These are functional demonstrations recorded after implementation. The [build journal](BUILD_JOURNAL.md) records the construction and review steps; the videos are not a continuous historical recording of every edit.

## Public verification and release status

The initial Worker version was `4e039a2b-f713-4dc1-9c72-dcd253c07b47`. A separate real D1 database, both migrations and native write limiter were deployed successfully in the already verified Workers Free account, without a plan upgrade.

The initial live stress run submitted three maximum-collection cases: mixed faults, permanent unavailability and lost acknowledgements. All saves returned 201, all reads returned 200, and full results matched the built CLI. All three owned synthetic records were removed. Observed CPU was 17–38 ms, above the 10 ms Free allowance despite successful responses. Startup initialization, encoded-response reuse, stable heap scheduling and compact fingerprint storage reduced repeated work. Larger local scenarios retain support, while new server saves are explicitly capped at 20 events and 40 deliveries.

The current version is `b8d57adb-6cc5-47be-a4aa-e59e399bd461`, with 51 ms startup. Its three server-maximum scenarios all saved, reopened with full CLI-equivalent results and were removed. Observed request CPU was 4–9 ms in five replay/read requests and 17 ms in one acknowledgement-loss save; no request failed or reported an exceeded-CPU outcome. Thus functional maximum-size checks passed, but a strict every-request 10 ms performance target is not established. Cloudflare documents [limited tolerance for infrequent CPU overages](https://developers.cloudflare.com/workers/platform/limits/#cpu-time); do not treat that as guaranteed headroom. Local replay/export remain available if hosted saving fails.

The repository is published at [rahul-singh-au9/integration-replay-lab](https://github.com/rahul-singh-au9/integration-replay-lab). [Initial hosted CI](https://github.com/rahul-singh-au9/integration-replay-lab/actions/runs/35204966481) passed for revision `3367aa5` with 129 unit/API/client/import tests, nine CLI tests and 39 browser journeys. The expanded final revision needs its own hosted check.

Remaining checks at this stage: remote scheduled cleanup, bounded security/rate-limit checks, three-engine public journeys and final hosted CI. Results will be recorded here after execution.

## Interpretation limits

This release simulates delivery of complete order snapshots. Consumer decisions are modeled in memory; D1 stores replay artifacts rather than real business transactions. It does not dispatch webhooks, process payments or establish exactly-once behavior across distributed systems. Concurrent consumers, dedupe expiry and retry exhaustion after an earlier committed effect are outside the current model. Cookie loss loses saved-run access. Anonymous traffic can exhaust shared hosting quotas. See the scenario format, threat model and operations guide for details.
