# Operations

Integration Replay Lab compares deterministic order-snapshot processors under authored delivery failures. Replay runs in browser memory or in the same-origin Worker. Optional server saving stores the validated scenario and its server-computed result in D1. This is real application persistence, but the orders, deliveries, acknowledgements, and retry clock inside each replay are simulated. The application makes no outbound calls to webhook destinations or model providers.

Browser-only results are held in memory, not a localStorage database. Export a useful scenario/result or explicitly save it before reloading or leaving the page. A saved result records its engine version; rerunning it after an engine change is a new computation.

## Keep the deployment free

The supported deployment uses Cloudflare **Workers Free**, static assets, one D1 database, and the included `workers.dev` address. No purchased domain, paid model, R2 bucket, or external telemetry subscription is required. Check that the selected account is actually on Workers Free before creating resources. An existing paid account does not become free by deploying this repository. Do not enter payment information or upgrade a plan to resolve a deployment or capacity problem; browser replay and JSON export remain the fallback.

Cloudflare advertises [Workers signup without a credit card](https://www.cloudflare.com/products/workers/). Free services may change or end under the [provider's terms](https://www.cloudflare.com/terms/); this design is not a permanent-free-hosting guarantee. No personal-only or noncommercial-only restriction was found in the reviewed Workers Free pricing and terms.

Provider limits checked on 2026-09-17:

| Resource | Relevant Free-plan allowance |
| --- | --- |
| Worker API | 100,000 requests per day; 10 ms CPU per invocation. Waiting for I/O is different from CPU execution. [Pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| Static assets | Asset requests and storage are free. Keep `run_worker_first` restricted to `/api/*` so ordinary asset requests do not invoke API code. [Billing and routing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/) |
| D1 operations | 5 million rows read and 100,000 rows written per day, resetting at 00:00 UTC. Reads count rows scanned; indexes and counter updates also affect work. Queries fail at free limits rather than automatically upgrading the plan. [Pricing](https://developers.cloudflare.com/d1/platform/pricing/) |
| D1 capacity | 500 MB per database, 5 GB per account, 10 databases, and seven days of Time Travel recovery. [Limits](https://developers.cloudflare.com/d1/platform/limits/) |

Allowances are shared with other projects on the account. Storage limits do not bound request abuse, scans, or repeated save/delete churn. A maximum-size replay also needs measured Worker CPU headroom; browser or local test speed does not establish production Free-plan CPU compliance. If valid inputs exceed the CPU budget, reduce scenario limits or keep them local instead of upgrading.

No timed inactivity suspension was found in the reviewed Workers/D1 documentation. Workers use [quickly initialized isolates](https://developers.cloudflare.com/workers/reference/how-workers-works/), which does not promise zero startup, database latency, or guaranteed availability.

## Application capacity and retention

- At most 20 unexpired saved runs per anonymous browser workspace.
- At most 500 saved rows across the deployment, including expired rows waiting for cleanup.
- A validated scenario is at most 64 KiB and its computed result at most 512 KiB, measured as UTF-8 bytes at the API boundary. Their combined maximum is 576 KiB, below the 600 KiB entry budget before row metadata and database overhead.
- At those payload maxima, 500 runs hold approximately 281.25 MiB of scenario/result text. Indexes, row metadata, SQLite allocation, and migration history require additional space; monitor actual D1 size.
- Runs expire 30 days after creation. Reads and deletes exclude a row at its exact expiration time, before cleanup has physically removed it.
- Scheduled cleanup runs daily at 03:17 UTC. Failed cleanup can leave expired rows using global capacity until a later successful run.

A single guarded insertion checks the owner limit and global counter while inserting the row. Triggers update the counter on insertion and deletion, including expiry cleanup. Never free capacity by deleting other visitors' unexpired runs. A capacity error should leave local replay and export usable.

The 30-day saved-run lifetime is unrelated to the replay's idempotency memory. Each replay starts from its scenario and retains simulated processing history only for that finite run; it does not test a production idempotency-key retention policy.

## Anonymous access and recovery

The production credential is `__Host-irl_session`: 32 cryptographically random bytes encoded as hexadecimal, with `HttpOnly`, `Secure`, `SameSite=Strict`, and `Path=/`. D1 stores the SHA-256-derived owner identifier, not the raw cookie. Local HTTP development uses `irl_session` without the `Secure` prefix requirement. Every run read and deletion is scoped to the derived owner.

Clearing cookies, losing a device, or moving browsers loses access to that workspace's saved runs. There is no verified identity, password reset, or account-recovery service. Export/import restores content into a new workspace; it cannot recover the old cookie or unlock old records. Export useful scenarios before clearing site data. Exported files are readable data.

Validate and redact imported scenarios before saving. Schema checks are not secret scanning or personal-data redaction. Use synthetic or deliberately sanitized examples in public demonstrations. The deployment operator and Cloudflare can administer stored data; it is not end-to-end encrypted.

## Rate limiting

The native [Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) protects mutations, including session creation, with 10 calls per 60-second period keyed by the connecting IP. `wrangler.jsonc` uses namespace `1002`, separate from other applications. Keep namespace IDs distinct unless shared accounting is intentional.

These counters are approximate, eventually consistent, and local to a Cloudflare location. Shared networks can cause false positives, while rotating IPs can bypass limits. They do not enforce a global request or spending budget. Missing or failed protection must fail closed. Exact storage capacity remains enforced in D1.

The reviewed binding documentation does not publish a separate price or explicitly establish Free-plan entitlement. Confirm availability without enabling a paid feature before relying on it for deployment. Do not infer entitlement from examples referring to an application's free users. If deployment rejects the binding, stop and revise the free design rather than upgrade.

Cloudflare documents [local simulation](https://developers.cloudflare.com/workers/local-development/bindings-per-env/) for D1 and rate limiting. A test double can exercise a rejection response, but it does not verify distributed counter behavior.

## Local verification and deployment

Use the Node release specified by `.nvmrc` and locked dependencies:

```sh
npm ci
npm run db:migrate:local
npm run check
npm run test:e2e
npm run audit:dependencies
```

After building, `npm run preview` serves the production assets with local Worker/D1 bindings on port 8790. It uses `--local`; local tests must not touch a production database. A development server is not a deployed service.

For an authorized deployment, select a verified Workers Free account, create a D1 database named `integration-replay-lab`, and replace the all-zero `database_id` in `wrangler.jsonc`. Apply reviewed migrations with `npm run db:migrate:remote`, then deploy with `npm run deploy`. These commands change the selected remote account. Verify the account and target database first.

After deployment, check HTTPS cookie flags, two-browser isolation, rejected cross-origin writes, health failure when the schema is unavailable, capacity and byte limits, rate-limit rejection, save/load round trips, and expiry scheduling. Confirm API failures never mark an unsaved result as saved and that local replay/export remain usable. Do not load-test a public Free account to its provider limits.

## Monitoring and incidents

Use existing provider request/error and D1 usage views. Log operational request IDs and error categories only. Never log session credentials, imported scenarios, order payloads, or exported files. Sampling is not permission to log sensitive content.

For 429 responses, respect the retry interval instead of looping. For capacity or provider-limit failures, preserve local operation and inspect usage. If owner isolation fails, take saved-run access offline before investigating. A successful health endpoint establishes database/schema access, not complete service correctness or quota headroom.

Restoration can resurrect deleted or expired content. Run retention cleanup and review deleted-data handling before reopening recovered storage. Application expiry does not imply immediate erasure from provider recovery history or downloaded exports.

## Backup and rollback

The commands below use verified Wrangler syntax. Replace uppercase placeholders before execution. Confirm the selected account, database, and recovery point. SQL backups contain all stored scenarios, results, and owner identifiers; keep them in a private directory outside the repository with a deliberate retention policy.

Before a migration, record a bookmark and export:

```sh
npx wrangler d1 time-travel info integration-replay-lab --json
npx wrangler d1 export integration-replay-lab --remote --output "/ABSOLUTE/PRIVATE/BACKUP.sql"
```

[D1 export](https://developers.cloudflare.com/d1/best-practices/import-export-data/) produces SQL and can temporarily block database requests. Check the exit code and file. Do not overwrite the only good backup.

For an application release rollback:

```sh
npx wrangler versions list --name integration-replay-lab --json
npx wrangler rollback "WORKER_VERSION_ID" --name integration-replay-lab --message "Restore verified application version"
```

A [Worker rollback](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/) does not restore D1 data or schema. Verify code/schema compatibility, then repeat isolation and save/load checks.

For database damage, first stop writes or take saved-run storage offline. Capture the current bookmark/export if possible, then choose a recovery point within the **seven-day Free-plan window**:

```sh
npx wrangler d1 time-travel info integration-replay-lab --timestamp "RFC3339_UTC_RECOVERY_TIME" --json
npx wrangler d1 time-travel restore integration-replay-lab --bookmark "BOOKMARK_FROM_INFO"
```

[Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) is already enabled; recovery has no additional charge. Restore overwrites the remote database and cancels in-flight queries. Preserve the previous bookmark returned by the operation in case reversal is needed. Generic CLI wording about 30 days does not change the Free plan's seven-day window.

Rehearse an SQL restore into an empty local persistence directory:

```sh
npx wrangler d1 execute integration-replay-lab --local --persist-to "/ABSOLUTE/EMPTY/RECOVERY_DIR" --file "/ABSOLUTE/PRIVATE/BACKUP.sql"
npx wrangler d1 execute integration-replay-lab --local --persist-to "/ABSOLUTE/EMPTY/RECOVERY_DIR" --command "SELECT (SELECT COUNT(*) FROM runs) AS actual_runs, (SELECT run_count FROM capacity WHERE id = 1) AS recorded_runs;"
```

Check schema, indexes, triggers, counts, and migration history. Import is not a merge; do not run backup schema/data statements blindly over an occupied database. If remote import is needed, create an empty recovery database within the existing Free allowance and reference it in a separate reviewed configuration:

```sh
npx wrangler d1 execute RECOVERY_DATABASE_NAME --config "/ABSOLUTE/PRIVATE/RECOVERY_CONFIG.jsonc" --remote --file "/ABSOLUTE/PRIVATE/BACKUP.sql"
```

Before switching the application binding, verify counts and owner isolation, remove expired data, and reconcile any restored deletions. Keep storage offline if its retention obligations cannot be preserved. A recovery database is an additional resource within the existing Free allowance, not an instruction to upgrade.
