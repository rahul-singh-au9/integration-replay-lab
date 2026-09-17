# Integration Replay Lab

Reproduce integration failures before connecting a customer system. Import a bounded delivery scenario or use an example, then compare a naive consumer with an idempotent, version-aware consumer. Inspect the resulting order snapshots, retry attempts, duplicate work and dead letters.

The first release models **complete order snapshots** and a simulated transport. It does not make network calls to supplied destinations, process payments, or connect to live customer systems. Simulated delays use a virtual clock, so replay is deterministic and finishes immediately.

## Working scope

- Duplicate deliveries, out-of-order revisions, a timeout after a successful commit, and permanent unavailability.
- A simple consumer that applies every delivery, compared with a consumer that remembers event identities and content, rejects conflicting reuse, and avoids applying stale revisions.
- Bounded retries that retain the original event identity and payload. Transport outcomes remain distinct from consumer outcomes.
- Final state and per-attempt evidence for both strategies, including work that occurred before an acknowledgement was lost.
- JSON import and export, with strict size and reference validation.
- Server-computed replays saved in D1, with private browser-scoped list/open/delete access and 30-day retention.
- Explicit local replay and export when server storage is unavailable. Local results are never labelled as saved.

This is a developer testing workbench, not a live webhook gateway. Passing these examples does not establish exactly-once execution across real distributed services. Source revisions and event identities are supplied inputs. Revision gaps are acceptable only because events contain full snapshots; incremental updates need different handling.

## Run locally

Use Node 24.21.0 from `.nvmrc`:

```sh
npm ci
npm run build
npm run db:migrate:local
npm run preview
```

Open `http://127.0.0.1:8790`. The frontend, Worker API, local D1 and rate limiter run together. `npm run dev` provides frontend hot reload while the API preview remains running.

```sh
npm run check
npm run audit:dependencies
npx playwright install chromium
npm run test:e2e
```

Browser tests run an isolated backend on port 8791 using `.wrangler/test-state`. The interactive preview database is separate. CI runs strict typing, unit/API tests, production build, dependency audit and browser checks.

For repeatable command-line checks, export a scenario from the UI, then:

```sh
npm run build:cli
npm run --silent replay -- scenario.json --fail-on-conflict --fail-on-dead-letter
```

The command prints the computed result as JSON. Exit status is 0 for a completed replay, 1 when a requested conflict/dead-letter condition is present in the guarded strategy, and 2 for invalid input or invocation. An expected-failure example may intentionally return 1; these flags are release conditions chosen by the caller, not an automatic judgment about whether a scenario is a useful test. The CLI makes no network requests or database writes.

## Architecture and data

React/TypeScript provides the inspection workspace. A shared Zod schema bounds imported scenarios. A pure replay engine drives both the browser's explicit local mode and the Worker's saved mode. D1 stores each validated scenario and its computed result with the engine version, rather than trusting a result uploaded by a client.

```text
Scenario → validation → deterministic retry queue
                           ├─ naive consumer → snapshots + attempts
                           └─ guarded consumer → snapshots + attempts
              explicit server run → owner-scoped D1 record
```

- `src/core`: schema, replay engine, examples and invariant tests.
- `src/ui`: scenario selection/import, results and saved replay library.
- `worker`: private sessions, server replay, persistence and cleanup.
- `migrations`: versioned SQLite schema and atomic capacity tracking.
- `tests`: browser journeys and accessibility checks.

There are no hosted model dependencies, external connector credentials, third-party analytics or remote font requests. Dependencies are pinned and were checked against current stable releases on 2026-09-17.

## Storage, privacy and limits

Saved runs are private to a cryptographically random HttpOnly browser cookie. There are no email accounts or recovery service; clearing the cookie loses access. Export files provide content portability. The hosting provider and deployment operator can access stored data. Remove secrets, customer identifiers and personal data before running a saved scenario.

Each browser can retain 20 runs. Scenario input is limited to 64 KiB, 50 event records and 100 deliveries. Stored replay output is capped at 512 KiB. Global capacity is 500 runs, approximately 281 MiB of maximum scenario/result JSON before database overhead. Runs expire after 30 days and a daily job removes expired rows. Native rate limiting provides approximate per-location write throttling; exact capacity is enforced atomically in SQLite.

## Free deployment

Use a verified **Cloudflare Workers Free** account, one D1 database and the included `workers.dev` address. Do not activate a paid plan or supply payment details to overcome a limit.

```sh
npx wrangler login
npx wrangler whoami
npx wrangler d1 create integration-replay-lab
```

Set the new database ID in `wrangler.jsonc`, then:

```sh
npm run db:migrate:remote
npm run deploy
```

Verify the actual HTTPS deployment with `BASE_URL=https://your-worker.workers.dev npm run test:e2e`. These tests create and remove synthetic records; run them only against a deployment you administer. Wait a minute between live runs to avoid the intended shared-IP write limit.

Workers Free includes 100,000 API requests/day and 10 ms CPU per invocation. D1 includes 5 million rows read/day, 100,000 rows written/day, and 500 MB per database. Static asset requests are free. Limits are shared with other applications in the account. Native rate-limit binding availability must be confirmed without enabling a paid add-on. See [Operations](docs/OPERATIONS.md) for primary sources, maintenance, backup and recovery procedures.

## Acceptance criteria

1. A duplicate or timeout-after-commit produces no second guarded effect.
2. An older full snapshot never replaces a newer guarded snapshot.
3. Reused event identities or contradictory versions are quarantined rather than silently accepted.
4. Permanent transport failures exhaust a finite retry budget and produce inspectable dead letters.
5. The same scenario produces the same attempts, metrics and final state in local and server modes.
6. Saved results survive reload and cannot be read or deleted by another browser session.
7. Invalid input, storage failure and quota exhaustion never appear as a saved success.
8. Desktop and 390 px mobile journeys have no horizontal page overflow; tested views have no serious or critical automated accessibility findings.
9. Application assets stay under 250 KiB gzip and bounded replay has a 100 ms local regression threshold. This is not a cloud CPU guarantee.

Actual test results and deployment status are recorded in [Verification](docs/VERIFICATION.md). Read the [Scenario format](docs/SCENARIO_FORMAT.md) and [Threat model](docs/THREAT_MODEL.md) before interpreting results or adapting a real integration.
