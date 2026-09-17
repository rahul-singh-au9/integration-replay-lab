# Build journal

This records the implementation, decisions and verification for Integration Replay Lab. The starting implementation is reconstructed from revision `8bbcd0d` and its verification record. Subsequent entries record the completion review on 2026-09-17. Reconstructed history is not a continuous recording of the earlier development process.

Credentials, authentication pages, cookies, private account details and real customer data are excluded. Demonstrations use synthetic scenarios. Completed checks and pending checks are distinguished explicitly.

## 1. Define a focused integration workbench

The application reproduces delivery failures using complete order snapshots and a virtual retry clock. It compares a naive consumer with one that remembers event identity/content and rejects stale or contradictory revisions. The purpose is to make common integration failures repeatable and explain the resulting state changes, retries, duplicate effects and dead letters.

The first release deliberately simulates delivery. It does not dispatch webhooks, process payments or connect to production customer systems. Source identity and revisions are supplied assertions; a successful simulation does not establish exactly-once effects across distributed services. Revision gaps are meaningful only because each event is a full snapshot.

The bounded scope includes authored scenarios, JSON editing/import/export, attempt and state inspection, explicit local replay, server-computed saved runs, a private saved-run library and a command-line interface. The acceptance criteria are maintained in the [README](../README.md).

## 2. Establish the initial full-stack implementation

Revision `8bbcd0d` introduced React/TypeScript views, a shared schema and deterministic replay engine, a Worker API, D1 migration, CLI, local checks and CI configuration.

The browser performs explicitly requested local replay without uploading the scenario. A server replay validates the scenario, computes both strategies and persists the result in D1. Saved runs belong to a random browser credential; the database stores its derived owner identifier. This provides workspace separation without an email identity or account recovery service. JSON export preserves useful work when storage is unavailable or a cookie is lost.

Initial local evidence recorded 25 core tests, 14 API tests, four CLI process tests and seven Chromium journeys. It established a working starting point, not completed public deployment or a comprehensive security review.

## 3. Review the complete application before publication

The completion review is split across three independent areas: scenario/replay/CLI correctness; API/database/security controls; and UI/client/accessibility behavior. Changes remain scoped to the existing product rather than adding unrelated infrastructure.

Initial findings include oversized-array validation work, unbounded CLI file reads, unvalidated saved results, session body handling, route/method responses, asynchronous UI races and incomplete mobile keyboard behavior. Confirmed defects were corrected with focused regressions. Saved-result integrity, bounded I/O, strict response contracts, atomic storage admission and UI request-generation guards now protect these paths; measured outcomes appear below.

The interface review treats this as a developer workbench: input, simulation status, consumer comparison and evidence need clear hierarchy. Loading, empty, saved, unsaved, failure and quota states must be distinct. Mobile navigation and dialogs must support keyboard focus, small screens and long imported values. A visual state is not accepted solely because an automated test passes.

## 4. Strengthen engineering checks

Typed ESLint, React hook checks, consistent formatting and selected-module coverage reporting were added to the verification setup. TypeScript 6.0.3 was selected because the current typed-lint parser officially supports versions below 6.1; unsupported peer dependencies are not forced. Runtime dependencies remain pinned, and dependency update proposals require separate review.

The browser configuration now includes Chromium, Firefox and WebKit, each with a separate local D1 persistence directory and port. The interactive preview on port 8790 remains separate. Hosted workflow permissions remain read-only and action revisions are pinned.

The completion sequence is:

1. Finish the scoped fixes and review their contracts together.
2. Run lint, formatting, strict typing, core/API/client tests, CLI process tests and production builds.
3. Run all browser engines, manual desktop/mobile review and accessibility/performance checks.
4. Rehearse isolated database backup, restore and actual scheduled cleanup.
5. Record complete desktop/mobile functional walkthroughs, including clearly labelled injected failures.
6. Publish reviewed source under the owner's selected GitHub account and verify hosted CI.
7. Create the separate D1 database in the already authorized Workers Free account, apply migrations and deploy.
8. Verify the actual public HTTPS app, ownership, limits, scheduled retention and maximum-scenario Worker CPU, then record measured results and remaining constraints.

No paid feature or plan upgrade is part of this sequence. Local replay/export must remain usable when optional saved-run storage is unavailable.

## Continuing the record

For each completed stage, record the concrete change, reason, affected area, commands/checks and measured outcome. Link relevant revisions and verification artifacts. Record deployment versions and distinguish local measurements from provider CPU observations. Do not label pending work complete or claim that testing proves the absence of vulnerabilities.

## 5. Complete correctness, security and interface fixes

Validation now rejects oversized arrays before per-item work, enforces timestamp precision, bounds CLI reads and verifies saved results against current deterministic computation. The API validates session bodies, routes and methods, streams request bodies within limits, fails closed on limiter failure, uses atomic owner/global capacity guards and rejects corrupt saved output. The second database migration adds byte guards and an owner/expiry index.

Client requests and session coordination have finite deadlines. Obsolete responses/imports cannot replace newer selections. The interface distinguishes saved and local results, preserves dialog return focus across browser behavior, and handles mobile navigation/resize without trapping scrolling. JSON result response construction reuses validated serialized values while preserving escaping and response headers.

## 6. Verify locally and rehearse recovery

The final local engineering check passed 129 core/API/client tests, nine separate CLI process tests, lint, formatting, strict typing and both production builds. Thirty-nine browser journeys passed across Chromium, Firefox and WebKit without retries. A WebKit focus-restoration failure found during review was fixed in the interface and rechecked in all engines. Selected-module coverage and measurement scope are recorded in [Verification](VERIFICATION.md).

An isolated local recovery run applied both migrations, exported/restored SQL, compared content digests and schema objects, checked owner/expiry access and byte guards, and invoked real scheduled cleanup twice. Capacity counters stayed consistent. The interactive preview and cloud database were not used as recovery targets.

## 7. Record functional walkthroughs

Continuous desktop and mobile browser walkthroughs were recorded with synthetic inputs. The desktop video covers fixtures, detailed replay evidence, custom conflicts, JSON workflows, persisted library actions and explicitly labelled failure recovery. The mobile video shows navigation, inspection and import. Both recordings were converted to captioned MP4, fully decoded, visually inspected and checked for playback and seeking. The local player supports byte ranges.

Video duration is about 2:31 desktop and 0:37 mobile. These demonstrate working functionality; they do not retroactively record the earlier edit history. Chapter metadata, original videos and review frames remain with the local evidence.

## 8. Deploy and investigate actual platform performance

A separate D1 database was created in the authorized Workers Free account. Both migrations and the native write limiter deployed successfully. The application was published to its own workers.dev address. The existing local preview database identity is preserved through a separate local preview identifier. No paid service was activated.

Initial maximum-scenario HTTPS tests returned complete correct server results matching the built CLI, and all owned test records were removed. Actual request CPU measured 17–38 ms, above the Free-plan allowance. This finding was retained instead of treating successful HTTP responses as a performance pass.

The Worker now initializes fixed bounded replay paths during startup and avoids repeated encoding of large result objects. Tests preserve full validation, input limits, result integrity and escaping. A measured cloud rerun is the acceptance criterion; local optimization measurements alone are insufficient.

## 9. Reduce repeated storage work and retry scheduling cost

The first startup/serialization optimization improved several live cases, but the maximum mixed and acknowledgement-loss cases still exceeded 10 ms CPU. A smaller test also lacked consistent headroom, so reducing advertised limits was not accepted as a substitute for addressing the repeated work.

New saved rows now store the validated scenario, engine version and SHA-256 fingerprint of the canonical computed result. Opening a row recomputes and verifies the result, as before, without transferring hundreds of kilobytes of repeated attempt text through D1. Strict envelope validation and legacy full-result equality preserve compatibility and reject damaged records. Unknown engine versions still fail closed. This representation needs no schema change, but rollback must use a reader that understands it.

The retry scheduler now uses a stable minimum heap rather than repeatedly sorting the queue. Four fixture results and twelve seeded maximum-size results match complete-result fingerprints captured from the previous implementation, and independent sorted-schedule comparisons cover every attempt in both strategies. Scenario limits and observable replay behavior remain unchanged.

The initial published revision passed hosted CI: 129 unit/API/client/import tests, nine CLI checks and 39 browser journeys with no retries. Later optimization checks are recorded separately. Dependency update proposals now respect the compiler/parser compatibility range and Node 24 declaration target.

## 10. Make hosting bounds explicit

Compact storage and heap scheduling brought later maximum-scenario calls down to 7–8 ms, but first large saves/reads still measured 21–28 ms. Increasing initialization from ten to one hundred passes raised Worker startup to 232 ms without eliminating those spikes, so that experiment was reverted. Cloudflare allows occasional CPU overages, but this application does not rely on that tolerance as its performance target.

Server saves now support 20 event records and 40 deliveries. The browser and CLI retain 50-event/100-delivery local replay and export. The UI explains the distinction and prevents an oversized save; the API rejects it before replay and insertion. This is an explicit product limit for free hosting, with an unchanged larger local simulation capability. The bounded live verifier now targets the actual server maximum and checks over-limit rejection.

## 11. Verify the bounded release

The updated local release passed 157 core/API/client/import tests, nine CLI process tests and 42 browser journeys across three engines without retries. The additional browser journey proves that larger scenarios remain usable locally and exportable without sending a prohibited save. The restored database check now includes both new fingerprint and legacy full-result representations.

Version `b8d57adb-6cc5-47be-a4aa-e59e399bd461` deployed with 51 ms startup. All three actual server-maximum scenarios saved and reopened with full CLI-equivalent results, then their owned records were removed. CPU observations were 4–9 ms for five replay/read requests and 17 ms for one save. No provider CPU error occurred, but the stricter every-request 10 ms target remains unproven. This observation is preserved in the verification record.

## 12. Confirm scheduled retention and public journeys

The actual Cloudflare scheduler removed the expired synthetic record and preserved the active record. The daily 03:17 UTC schedule was restored and both verification records were removed. This confirms remote scheduling in addition to the isolated local handler and recovery checks.

All 42 public browser journeys passed without retries across Chromium, Firefox and WebKit. Real server journeys verified persistence, ownership and deletion; injected-error journeys remained explicitly controlled. The published source revision `4f416d6` also passed hosted CI with 157 unit/API/client/import tests, nine CLI checks and 42 browser journeys.

## 13. Polish the final interface and measured computation

The import success message now tells larger-scenario users to run locally and export, matching the disabled save action. Both the larger and within-limit messages have browser regressions. The complete videos were refreshed to show this final text.

Within each replay, timestamp normalization and semantic fingerprints now reuse primitive strings per record. Consumer state and returned objects remain independent; nothing is cached across user replays. The 20/40 timeout case uses 20 timestamp conversions instead of 180, with identical complete results. The additional mutation-isolation regression brings the focused test count to 158.

Version `c8d81461-7fe0-43e3-96c8-603b9c6d419c` deployed with 67 ms startup. Three actual maximum saved scenarios returned full CLI-equivalent results and were cleaned up. Observed CPU still varied from 4 to 20 ms, so strict 10 ms headroom is not claimed. Current performance limits and fallback behavior remain explicit in the release record. Actual malformed-input and rate-limit checks passed without leaving saved records.

## 14. Finish release evidence and handoff

The final imported-limit flow passed focused checks in all three public browser engines. Updated desktop (2:42) and mobile (0:37) MP4 recordings passed full decoding, playback, seeking and visual inspection, including the corrected larger-scenario guidance. Original browser recordings and chapter data remain alongside the playable files.

Public health, response-header, anonymous-access, cross-origin and route/method checks passed. Invalid input and server-limit violations produced expected 400/413 responses and no stored run. Native throttling produced 429 with Retry-After: 60; after the cooldown, three maximum saved scenarios again created, reopened and deleted successfully. Cleanup was limited to owned synthetic data. A 17 ms CPU observation in that recovery round remains disclosed.

The final source, operations guide, verification record and this journal are published together. The main branch verification workflow runs the final 158 focused tests, nine CLI checks and 42 local browser journeys. The public deployment, source repository, local videos and build record are the handoff artifacts.
