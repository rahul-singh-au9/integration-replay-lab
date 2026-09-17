# Engineering and security review

Reviewed 2026-09-17. This is a bounded integration simulator with optional private persistence. The controls and tests below support its documented scope; they do not prove that no vulnerabilities remain or that a simulated consumer is a production webhook service.

## Architecture and correctness

The same pure replay engine serves the browser, server and CLI. Validation is centralized, and server runs accept scenarios rather than client-computed decisions. Imported results are ignored. Saved results must match a fresh deterministic computation for the supported engine before display. Unknown engine versions require an explicit compatibility/migration decision, not silent replacement of historical conclusions.

The engine distinguishes transport acknowledgement, consumer disposition and simulated side effects. Retry identity and payload remain stable; deduplication does not mean that an unacknowledged request had no effect. Event identity conflicts and contradictory order revisions are separate from transport dead letters. Full snapshots and a virtual clock keep these assumptions explicit.

Input bytes, collection lengths, identifiers, numeric values, timestamp precision and references are bounded. Overfull arrays are rejected before per-item validation. Submillisecond timestamps are rejected because truncating them during canonicalization could hide an identity conflict. The CLI reads only regular files, checks bytes while reading and rejects malformed UTF-8; it neither calls external services nor writes to the database.

## Storage and security

- A 32-byte random browser credential uses HttpOnly, SameSite Strict and Secure/host-prefix protections on HTTPS. D1 stores its SHA-256-derived owner identifier rather than the cookie.
- All run reads and deletions require the owner and an unexpired row. Unknown routes return 404; unsupported methods return 405 with an Allow header.
- Mutations require the exact application origin, compatible fetch metadata and JSON content type. Session bodies are bounded separately at 1 KiB; streamed scenario bodies remain bounded even without a trustworthy Content-Length.
- Native write throttling fails closed. Exact owner/global storage admission and counter updates happen atomically in SQL, independently of approximate rate-limit counters.
- SQL parameters are bound. The second migration adds UTF-8 byte guards for insert/update and an index for owner/expiry checks. Expired rows are inaccessible before scheduled physical cleanup.
- Stored scenarios, result integrity and metadata are checked before return. Corrupt results produce a generic storage error; owner-scoped deletion still works so unusable records can be removed.
- Imported strings render as text. The application does not execute imported code, fetch supplied URLs or send webhooks. Static/API responses use restrictive browser headers and saved responses are noncacheable.
- Logs contain operational request IDs and error categories, not scenarios, payloads, cookies or personal data. Exports remain readable files and are not secret-scanned or end-to-end encrypted.

## Interface and asynchronous behavior

The design emphasizes scenario input, side-by-side consumer outcomes, delivery attempts and evidence. Blue indicates the active workspace/action, while transport and decision badges remain separate. Counters explain their units; virtual time is distinct from source timestamps. The primary action says **Run and save** and explains upload/retention, while **Run locally** remains explicitly unsaved.

Dialogs remember their actual opening button rather than assuming pointer clicks focus buttons in every browser. Mobile navigation traps focus while open, restores it on dismissal/selection and releases scroll restrictions when resizing to desktop. Long identifiers, amounts and imported text are checked at 320 px. Local, saved, empty, loading, failed and quota-limited states have distinct messages.

Request generations prevent obsolete saved opens, library refreshes or asynchronous file reads from replacing newer work. Successful API bodies are validated before entering UI state. Requests have a 15-second deadline, and cross-tab first-session coordination has a 30-second acquisition deadline. Saves are not automatically retried after uncertain responses; a committed result may already be in the library.

## Verification and maintenance

Typed linting, React hook rules, formatting, strict TypeScript, unit/API/client/import tests, CLI process tests and three-engine browser journeys are executable checks. Dependencies and hosted actions are pinned; update proposals require review. TypeScript stays within the typed-lint parser's [supported range](https://typescript-eslint.io/users/dependency-versions/).

An isolated recovery rehearsal verifies SQL backup/restore, both migrations, indexes, triggers, content digests, capacity invariants, restored owner access and actual repeated scheduled cleanup. It leaves the interactive preview and cloud database untouched. Recordings use synthetic inputs and label injected service failures explicitly.

Measured test counts, coverage, browser results, provider CPU and deployment versions belong in [Verification](VERIFICATION.md). Local benchmarks do not establish Free-plan cloud CPU headroom. Automated accessibility checks do not replace a comprehensive screen-reader or physical-device study.

## Remaining product limits

The credential is a bearer capability, not verified human identity. Cookie loss loses server access; exports recover content only. Anonymous traffic can exhaust shared Free-plan quotas despite throttling. A response lost after save can leave an uncertain result; refresh the library before repeating it.

This simulator does not model concurrent consumers, dedupe-key expiry, downstream effect delivery, jitter, arbitrary connectors or retry exhaustion after an earlier committed effect. Producer identities, revisions and event authenticity are unverified. See [Scenario format](SCENARIO_FORMAT.md), [Threat model](THREAT_MODEL.md) and [Operations](OPERATIONS.md) before adapting these ideas to a real integration.
