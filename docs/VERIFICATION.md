# Verification record

Date: 2026-09-17. Scope: local release candidate on macOS ARM64, Node 24.21.0, Chromium 153 through Playwright 1.63.0, Wrangler 4.133.0 with local D1 and native rate-limit bindings.

**Implemented and locally verified. Not deployed.** Cloudflare authentication is unavailable, the remote database ID is a placeholder, and the GitHub publishing account is unresolved. No public URL, remote database, or hosted CI result is claimed.

## Executed checks

| Check | Result |
| --- | --- |
| Strict TypeScript | Passed |
| Replay engine and API tests | 39 passed: 25 engine and 14 API |
| Production frontend and CLI builds | Passed |
| CLI process tests | 4 passed |
| Chromium browser tests | 7 passed |
| Dependency audit | 0 reported vulnerabilities at the time of checking |
| Local D1 migration | Applied successfully |
| Desktop/mobile visual review | Inspected replay, mobile navigation and import views; mobile at 390 px |

Engine checks cover duplicate delivery, lost acknowledgement after a commit, stale revisions, event identity collisions, contradictory snapshots at the same revision, retry limits, deterministic ordering and strict input bounds. They inspect final snapshots, effects, attempts and dead letters rather than relying only on displayed counters.

API tests execute the migration, SQL statements and triggers in SQLite. They exercise private cookie sessions, owner isolation, cross-origin defenses, malformed input, streaming limits, retention, service failures and atomic capacity enforcement. The server computes results from the validated scenario; it does not trust uploaded results. Stored results retain their engine version when opened later. Browser tests independently exercise actual local Worker/D1 bindings.

CLI tests launch the built executable in a separate process and verify JSON output and exit status for a lost acknowledgement, retry exhaustion, an identity conflict, invalid input and an unknown option. They make no external requests.

Browser journeys verify server replay → export → local comparison → reload → open → delete. Exported server results match local computation. A separate browser cannot read or delete a known saved run. Other checks cover malformed JSON, unavailable storage, explicit unsaved local results, keyboard dialog focus, inert imported markup and long identifiers or amounts on mobile.

Accessibility checks use axe WCAG 2 A/AA and 2.1 AA rules. No serious or critical violations were found in the tested desktop/mobile replay views, method and JSON views, or import dialog. No horizontal page overflow was found at 390 px, including long identifiers and maximum integer amounts. Automated checks and limited keyboard review are not a comprehensive accessibility certification or screen-reader study.

## Measured local performance

- A bounded stress scenario with **50 event records and 100 deliveries**, 64-character identifiers and maximum safe integer revisions/amounts evaluated in a median **0.840 ms** across 15 measurements. Input size was 35,728 bytes. The local regression threshold is 100 ms.
- The mixed-fault output was **364,594 bytes** with 500 combined attempts across both strategies. Permanent unavailability produced **378,338 bytes**, 600 combined attempts and 200 combined dead letters. Both outputs fit within the 512 KiB persisted-result limit. These cases are stress examples, not a proof of the largest possible serialization; the API enforces the output limit independently.
- Application JavaScript and CSS totaled **109,657 bytes gzip**, below the 250 KiB target.
- The local browser usability check completed in **577 ms**, including a 500 ms network-idle observation. No third-party requests occurred. This is a smoke test, not a mobile-network or Core Web Vitals measurement.

These measurements do not establish Cloudflare CPU usage, global latency, sustained concurrency or availability. The actual Workers Free CPU budget remains a deployment acceptance check.

## Corrections during verification

A low-contrast import label was corrected before the passing accessibility run. Browser discovery now selects only browser specification files so that it does not execute the separate CLI suite. Mobile tests assert the visible local-result status rather than a redundant desktop-only badge.

Session initialization shares one in-flight lookup/creation within a page. This prevents startup and a quick replay from creating competing credentials in that page; it is not a cross-tab account synchronization system.

## Outstanding release steps

1. Authorize Cloudflare and verify Workers Free. Confirm native rate-limit binding availability without enabling a paid add-on.
2. Create remote D1, set its ID, apply the migration and deploy.
3. Run browser tests against the actual HTTPS URL. Verify health, storage, production cookie flags, isolation, scheduled cleanup and actual provider limits/CPU behavior.
4. Confirm the GitHub destination, publish and verify hosted CI.

This release simulates delivery of complete order snapshots. Atomic consumer decisions are modeled in memory; D1 stores replay artifacts rather than real business transactions. It does not dispatch webhooks, process payments, execute external effects, or establish exactly-once behavior in a distributed system. The available fault modes do not model retry exhaustion following an earlier committed effect. See the scenario format and threat model for interpretation limits.
