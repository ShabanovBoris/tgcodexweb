# TG WebGPT Gateway — R7 recovery and operations

This folder contains the bootstrap specification for a standalone Telegram gateway to browser-based ChatGPT via `codex-chatgpt-web` or a compatible provider adapter.

Read order:

1. `PRODUCT.md`
2. `ARCHITECTURE.md`
3. `ACCEPTANCE.md`
4. `ROADMAP.md`
5. `AGENTS.md`
6. `GOAL.md`

The repository includes the R0 shell, R1 domain/persistence, R2 durable acceptance
and keyed queue, and R3 application-owned provider contract, deterministic fake and
request lifecycle service. R4 adds conversation commands, Telegram HTTP polling,
allowlist checks, progress, safe response splitting and delivery fallback. R5 adds bounded file downloads, isolated temporary storage and durable albums with
explicit `/send` and `/discard`. R6 adds a local fork of the pinned upstream browser worker,
dedicated persistent profiles and the real provider path; live acceptance remains pending.
R7/R8 are not complete. See
[R1 evidence](docs/verification/R1.md), [R2 evidence](docs/verification/R2.md),
[R3 evidence](docs/verification/R3.md), [R4 evidence](docs/verification/R4.md),
[R5 evidence](docs/verification/R5.md) and [R6 evidence](docs/verification/R6.md).
R7 adds polling reconnect, explicit UNKNOWN completion, read-only doctor/status and bounded
durable final-result delivery. See [R7 operational evidence](docs/verification/R7-operations.md).

## Prerequisites and install

Use **Bun 1.4.0**, including its package manager and test runner. No system Node,
Telegram connection, ChatGPT login, browser, or unrelated project is needed for R0.
The recorded validation platform is macOS; see [R0 evidence](docs/verification/R0.md)
for the exact environment and limits of that evidence.

On macOS/Linux, the official installer accepts an exact release tag:

```sh
curl -fsSL https://bun.com/install | bash -s "bun-v1.4.0"
```

In the repository directory:

```sh
bun --version
bun run toolchain:check
bun install --frozen-lockfile
bun run verify
```

`verify` needs only declared local dependencies. It runs toolchain validation,
typecheck, lint, format checks and all local tests. Tests use synthetic values and
temporary directories and make no Telegram/ChatGPT requests. Package installation
requires access to the package registry; verification after installation is offline.

The exact upstream/toolchain evidence and integration limits are recorded in
[ADR 0001](docs/adr/0001-r0-toolchain.md) and
[ADR 0002](docs/adr/0002-r6-local-browser-fork.md). The browser-worker source subset is
vendored with its original blob hashes and license; its runtime packages are declared
and pinned in this repository.

## Local configuration

```sh
cp .env.example .env
```

Edit the local `.env` to fill `TELEGRAM_BOT_TOKEN` and
`TELEGRAM_ALLOWED_USER_IDS`. R0 checks only token presence, not its validity with
Telegram. Synthetic values suffice for local bootstrap testing. Never commit `.env`.

Automatic `.env` loading is disabled. Explicitly pass the file when needed:

```sh
bun --env-file=.env run config:check
bun --env-file=.env run bootstrap
```

Environment variables are the sole configuration source. Blank optional values use
defaults; missing/blank required fields yield `CONFIG_ERROR` and exit code 1 without
creating the database. Errors list field names and fixed reasons, never input values.

| Variable | Required / default |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Required nonempty string |
| `TELEGRAM_ALLOWED_USER_IDS` | Required CSV of positive decimal IDs, stored as strings |
| `PROVIDER_TYPE` | `chatgpt-web` only |
| `DATABASE_PATH` | `./data/gateway.sqlite` |
| `BROWSER_PROFILE_DIR` | `./data/browser-profile` |
| `BROWSER_EXECUTABLE_PATH` | Optional absolute or project-relative Chromium/Chrome executable; default is upstream's system Chrome path |
| `BROWSER_HEADLESS` | `false`; interactive login always uses a visible browser |
| `GENERATION_TIMEOUT_MS` | `600000` |
| `MAX_PENDING_PER_CONVERSATION` | `20` |
| `ATTACHMENT_TEMP_DIR` | `./data/tmp` |
| `ATTACHMENT_MAX_FILES_PER_REQUEST` | `10` |
| `ATTACHMENT_MAX_FILE_SIZE_BYTES` | `52428800`; hosted Telegram download additionally capped at `20000000` |
| `ATTACHMENT_TEMP_TTL_MS` | `86400000` (24 hours) |
| `ATTACHMENT_ALLOWED_EXTENSIONS` | CSV subset of the supported text/source/PDF/image extensions |
| `ATTACHMENT_ALLOWED_MIME_TYPES` | CSV subset of the supported MIME types |
| `LOG_LEVEL` | `info`; also accepts `debug`, `warn`, `error` |
| `LOG_CONTENT` | `false`; Boolean values must be `true` or `false` |

All numeric limits must be positive safe integers; `GENERATION_TIMEOUT_MS` additionally
must not exceed 2147483647 (the runtime timer limit). Relative paths resolve from the
working directory. A composed R3 `RequestService` consumes the pending queue and generation
timeout limits in the R4 runtime; the one-shot bootstrap does not run it. The R5 runtime consumes attachment limits and type policy.
`LOG_CONTENT` is validated,
but ordinary R0 logs have no prompt/response fields even when it is `true`.

## Bootstrap and database

`bootstrap` is a **one-shot local bootstrap**, not a running bot. It checks the toolchain,
validates configuration, initializes/migrates SQLite, logs `bootstrap.complete` and
closes the connection. Success exits 0; it never reports `READY`. `LOG_LEVEL=warn`
or `error` suppresses the informational success log.

`start --private` runs the real provider. It never falls back to fake. Like fake mode,
it requires explicit private-chat policy; Telegram token validation precedes database
and browser startup. Profile storage must be separate from attachment storage and
must not contain the application database.

Install a Chromium-compatible browser and set `BROWSER_EXECUTABLE_PATH` if system Chrome
is absent. A reproducible option is the browser revision associated with the pinned
Playwright package (the recorded synthetic browser tests use Chromium 151.0.7922.34):

```sh
PLAYWRIGHT_BROWSERS_PATH="$PWD/data/playwright-browsers" bun --no-env-file node_modules/playwright-core/cli.js install chromium
PLAYWRIGHT_BROWSERS_PATH="$PWD/data/playwright-browsers" bun --no-env-file -e 'import {chromium} from "playwright-core"; console.log(chromium.executablePath())'
```

Put the printed executable path in local configuration. Then, with the bot stopped:

```sh
bun --env-file=.env run browser:login
bun --env-file=.env run provider:health
bun --env-file=.env run start --private
```

`browser:login` requires a terminal and opens a normal Chrome window with only the
dedicated profile. Complete sign-in until ChatGPT shows your account and composer,
then quit that Chrome instance completely (Cmd+Q on macOS). The command waits for
the browser to exit and automatically checks the saved session. Neither login nor
`provider:health` requires a Telegram token.
Use a new empty directory initially: populated profiles without this gateway's ownership
marker are refused. Never copy another browser's profile, cookies or storage-state file.
The profile remains exclusively owned by one browser process, so stop the service before
running login in a second process. Browser/session failures return fixed codes only.

`/new` initializes a saved-chat draft without sending a seed message. Its opaque provider
ID remains stable; the first actual prompt binds its remote URL. `/add` supports a ChatGPT
UUID or `https://chatgpt.com/c/<uuid>` and verifies that the owned browser can render that
exact existing chat. Registering a newly created chat again converges on the same key.
This fork advertises one active conversation and no confirmed cancellation capability;
`/stop` reports unsupported. UNKNOWN blocks dispatch and is never automatically replayed.

If UNKNOWN blocks the queue, stop the bot and inspect the exact request in ChatGPT.
After verifying that its response has finished, record that explicit operator confirmation:

```sh
bun --env-file=.env run recover:unknown <request-id> --confirm-completed
bun --env-file=.env run start --private
```

The recovery command is offline and needs only `DATABASE_PATH`, without Telegram or browser
credentials. It releases that block while retaining UNKNOWN, deduplication and every queued
input. It neither resends the original request nor delivers its old answer. The next normal
start executes queued requests in their original order. A second confirmation is idempotent.
`DATABASE_ERROR` with reason `gateway_busy` means the running bot must stop first; this
version uses an exclusive SQLite lease through provider cleanup. Stop older bot versions
completely before recovery. Never delete or replace the `*-gateway-lock` file to unlock
the service: process death releases the lock automatically. The original submission
acknowledgement failure still requires separate diagnosis.

With the bot stopped, run the read-only preflight:

```sh
bun --env-file=.env run doctor
```

It prints one JSON report on stdout. `readyToStart` describes the checked prerequisites,
not a running daemon's `READY` state. Checks cover config, existing SQLite integrity and
immutable migration history, queue/delivery counts, Telegram `getMe`, the gateway lease
and provider health. Missing DB/migrations/profile are reported without initializing them.
When the bot holds the lease, the CLI skips the competing browser probe; use Telegram
`/doctor` for the owned runtime. Config/native errors expose fixed fields/codes, not values,
paths, tokens or browser credentials. Doctor never polls Telegram updates, creates a chat,
sends a prompt, uploads a file, reconciles requests or applies migrations.

Telegram `/status` shows component readiness, queue counts and the caller's request IDs;
`/doctor` adds capabilities and diagnostic details. An UNKNOWN explains how to inspect the
exact finished ChatGPT response and perform the offline recovery above. Other users'
request identifiers and aliases are not exposed. A failed database read reports `ERROR`
instead of a fabricated empty queue.

All standard verification is offline. To run the separate real-Chromium/synthetic-site
profile, set `TGWEBGPT_TEST_BROWSER` to an installed Chromium executable and run
`bun run test:browser`. Every URL is intercepted; no live ChatGPT account is used.
Actual ChatGPT checks require explicit operator opt-in after login:

```sh
TGWEBGPT_LIVE=1 bun --env-file=.env run test:live health
TGWEBGPT_LIVE=1 TGWEBGPT_LIVE_SEND=1 bun --env-file=.env run test:live roundtrip
```

The second command intentionally creates one saved chat and sends one synthetic prompt
with a synthetic attachment. Receipts contain states and hashes, never credentials or
full conversation content. A local browser test is not a live acceptance receipt. R6's
live exit criteria and the overall MVP acceptance pass remain pending.

To explicitly run a development bot against the real Telegram transport and a synthetic
provider, use your own test bot token and allowlist:

```sh
bun --env-file=.env run start:fake --private
```

This command connects to Telegram. It has not been run with live credentials in R4
verification. `--private` is required: only allowlisted non-bot senders in their matching
private chat are handled; groups, channels, anonymous senders and other update types are
silent. The group policy is an open product decision. All automated tests inject an
offline Telegram API. Standard transport tests use FakeChatProvider; the opt-in browser
suite also exercises the real fork against synthetic intercepted pages.

Fake mode displays `FAKE (development)` in `/start` and `/status`. It uses a separate
database next to `DATABASE_PATH`, with `fake-` prefixed to the basename (default:
`data/fake-gateway.sqlite`). It never opens the normal database or browser profile. Its attachment files live under
`ATTACHMENT_TEMP_DIR/fake/` and the fake adapter reads validated bytes through the store.
Known synthetic mappings, including archived mappings, seed the fake's available IDs;
new IDs are unique across restarts. It does not simulate persistent remote history or
real ChatGPT access/authentication. `/add sample remote` attaches a predefined synthetic
conversation. `/new coding` creates another synthetic conversation.

SIGINT/SIGTERM stop polling/admission and join active request effects before closing
SQLite. Known transient `getUpdates` failures reconnect in the same runtime: up to five
retries after 1/2/4/8/16 seconds, with the budget reset by a successful poll (including an
empty result). An explicit 429 `retry_after` is a minimum wait, up to 60 seconds; a longer
or invalid delay stops the runtime without an early retry. Reconnection preserves the
handled offset. Transport is non-ready at startup and during reconnection until a poll
succeeds. Token errors, poller/webhook conflicts, malformed successful responses,
unclassified failures and exhausted retries remain fatal. Initial `getMe` uses its own bounded
read-only retry before any database/provider initialization: the same five waits and safe
60-second flood-control limit. Initialization happens only once after identity succeeds.
Caller abort interrupts identity HTTP/backoff. Later reconnect does not repeat `getMe` or
application effects. Final-result delivery has its separate durable policy below. See
[R7 polling evidence](docs/verification/R7.md) and [current operations](docs/verification/R7-operations.md).
Polling acknowledges an update after handling it. Durable markers suppress redelivery
after a lost polling offset. Commands are marked before effects, so interrupted commands
are not automatically replayed; command crash reconciliation is not implemented.

Available commands are `/start`, `/help`, `/new [alias]`, `/add <alias> <url-or-id>`,
`/chats`, `/use <alias>`, `/current`, `/rename <old> <new>`, `/remove <alias>`, `/status`, `/doctor`,
`/stop`, `/send` and `/discard`. New aliases are case-sensitive, 1–64 UTF-16 units, without whitespace or
control/format characters. The provider verifies `/add` and supplies the opaque canonical
ID; the transport never derives it from the supplied URL. Ordinary text is preserved
exactly and targets the selected mapping. Telegram reply metadata does not branch the
provider conversation. Single supported files are submitted immediately with their exact
optional caption; captions that look like commands remain prompt text.

Albums wait for `/send` and survive restart as one draft per user. The first file fixes
the conversation; changing `/use` affects later ordinary text/single files. Files and
captions follow Telegram message order; captions are joined with a newline. `/send`
has no prompt argument. `/discard` closes the draft and removes its files. Drafts expire
after TTL from their first file. Late files of closed groups are rejected; a second open
album and unsupported/excess files are explicitly rejected before downloading. A queue-full
`/send` retains the draft so it can be sent later.

Supported documents include UTF-8 text/Markdown/source, PDF, JPEG, PNG, GIF and WebP.
The exact configurable defaults are exported in `src/application/AttachmentService.ts`;
configuration can restrict this set. ZIP is rejected pending a provider capability contract.
Photo messages select the largest dimensions and require JPEG bytes; other supported
images can be sent as documents. Size is checked on metadata and streamed bytes. Type
checks cover MIME/extension agreement, UTF-8/no-NUL and PDF/image signatures, not complete
format parsing. Filenames remain metadata; local files use random keys and mode 0600.

Cleanup runs after durable terminal outcomes and with a local TTL sweep (startup and
interval at most 60 seconds). Non-terminal accepted files and unclassified surviving refs
never expire. Failed-cleanup/crash orphans are removed after TTL; cleanup failure cannot
change completed generation or trigger another prompt. This uses no user-visible scheduler.
Telegram API failures/download deadlines are normalized and are not automatically retried.

Progress messages are queued/generating notifications followed by the durable outcome.
Progress delivery cannot delay provider observation. Completed responses preserve their
source text, escape arbitrary HTML and use balanced `<pre>` blocks for fenced code.
Other Markdown remains literal. Chunks respect the 4096 character limit conservatively
using UTF-16 units and do not split surrogate pairs. Only an explicit HTTP 400,
`ok=false`, parser rejection retries that chunk once as plain text.

R7 stores new terminal results atomically with provider settlement in forward migration
`0007_request_deliveries.sql`. A crash before Telegram delivery leaves the output available
for restart. The delivery worker has no provider API: it only sends the stored result to
the original, still-authorized user/message. Its stable render plan and confirmed-part
cursor survive restart. Under the explicitly approved policy, an ambiguously delivered
part may repeat; confirmed earlier parts do not. A completed provider request is never
submitted again for delivery recovery.

There are at most six attempts, with 1/2/4/8/16-second retry waits. A valid `retry_after`
is a minimum, up to the 60-second policy limit. Missing/invalid/longer minima and permanent
errors stop retries instead of sending early. The budget survives restart. Progress and
command notices keep their original one-attempt behavior. Shutdown aborts and joins owned
delivery work before closing storage and releasing the gateway lease.

Result/plan content is deleted after delivery or expires 24 hours after settlement. The
running sweep and next startup perform expiry cleanup, and expired content is never sent.
The error remains visible as `TELEGRAM_DELIVERY_EXPIRED` in `/status`/`/doctor`. No process
can physically clean a stopped database; WAL/backups retain the same deletion limitations
as R2 input. Previously completed rows without saved output cannot be recovered by this
upgrade. Durable delivery state and failures remain distinguishable from provider completion.

Database maintenance needs no Telegram credentials:

```sh
bun run db:migrate
```

To select another database, supply `DATABASE_PATH` through the environment or an
explicit env file. R1 adds `0001_domain.sql`: users, conversations, active selection,
requests, processed updates and attachment metadata. `0002_reuse_archived_alias.sql`
replaces global alias reservation with uniqueness for unarchived mappings. An R0 database
applies all migrations; a database at `0001`/`0002` upgrades forward without changing its
old ledger entries or data. R2's `0003_request_inputs.sql` adds operational input and a
durable acceptance sequence; `0004_request_acceptances.sql` adds retention ownership
that survives payload loss and backfills existing R2 inputs. A database at 0003 upgrades
forward too. See [migration rules](src/persistence/sqlite/migrations/README.md).
The connection enables foreign keys, WAL, FULL synchronous durability, a 5000 ms
busy timeout and strict parameter binding.

Before an upgrade or manual maintenance, stop every bot version using the database and
make a consistent SQLite backup in an ignored, private directory. Use SQLite's backup
facility or Bun `Database.serialize()` on a read connection while holding the gateway
lease; write the resulting image as a new file with mode 0600. Check that the backup
reopens and `PRAGMA integrity_check` returns `ok` before running `db:migrate`. Copying only
the main file while committed changes remain in WAL is not a consistent backup. Keep the
previous backup until the forward migration and restart checks pass. Never edit an applied
migration or delete the lease file to bypass a running process.

Data defaults to `data/`, which is ignored by Git. SQLite may retain `-wal` and
`-shm` sidecars; these are ignored too. Browser profile and attachment directories
are configuration only and are not created by R0. No authentication state is read
or imported from another project.

Logs are JSON lines on stderr with operational metadata, centralized redaction and
no raw config, environment, exceptions, prompts or responses. Database errors use
`DATABASE_ERROR`; runtime pin mismatches use `TOOLCHAIN_ERROR`.

## Development commands

```sh
bun run test:unit
bun run test:persistence
bun run test
bun run typecheck
bun run lint
bun run format:check
bun run format
bun run verify
```

`format` explicitly writes formatting changes. `verify` does not change source files.
Biome checks TypeScript/JSON; Markdown, TOML and SQL are outside its formatter scope.

The R4-only evidence predates the R6 provider and R7 doctor described above. Compatibility
with arbitrary existing ChatGPT conversations still requires opt-in live acceptance.

## R1 persistence contracts

`src/domain` contains validated, immutable business snapshots and a pure request
state reducer. `src/ports` defines synchronous repository contracts; SQLite adapters
implement them without Telegram SDK/browser types. Provider identifiers are opaque:
the canonical key is the exact provider conversation ID for the single MVP profile.
Different aliases may converge on that ID and share the R2 queue key.

Conversation aliases are unique per user among unarchived mappings. `/remove` releases
the name for `/new` or `/add` while the archived mapping and historical request IDs remain
unchanged. Rename/archive require the owner's user ID; foreign/missing IDs receive the same
`entity_not_found` error. Rename changes only alias/timestamp; archive clears active selection atomically and retains request
references. The selected mapping must belong to that user and be unarchived. User
metadata is persisted but does not replace the future transport allowlist check.

Requests are created with durable IDs and optional attachment metadata in one transaction.
The originating Telegram update ID is unique. Processed-update markers are immutable;
commands can have no request ID, and multiple markers may reference one request.
R2's compound acceptance transaction coordinates these primitives with durable input.

Request transitions retain `startedAt` separately from confirmed `submittedAt`.
`sending -> failed` requires `SEND_FAILED_PRE_SUBMIT`; ambiguous submission can become
`unknown`, which has no replay transition. Cancellation can settle as completed,
cancelled, failed, timeout or unknown according to provider evidence. Reopening storage
preserves states without provider reconciliation.
Only normalized failure codes are stored in R1; optional free-form redacted details from
the full architecture are deferred until a trusted error mapper exists.

Attachment metadata stores a transport file reference and optional generated storage key.
A remote filename is display metadata, never a local path. No files are downloaded or
uploaded, and no conversation history, response content or browser authentication is stored.

## R2 acceptance and queue contracts

`SqliteRequestQueueRepository.accept` commits request, ordered input/attachment references,
durable retention ownership, dedup marker and queued state together. A duplicate returns its original marker without
overwriting input or creating another request. Pending capacity is shared by aliases for
the exact remote ID, counts created/queued work and excludes active processing. A full
queue rejects without marking that update processed.

`RequestQueue` owns admission/dispatch and uses an injected async executor. This is a
single runtime with explicit pending/global concurrency limits; R3 supplies the
request-service callback and derives concurrency from provider capability. The callback
must cover the entire remote mutation and persist the correct terminal evidence before
it resolves. Test executors are deterministic and make no live network calls.

Startup reconstructs only queued requests with durable acceptance ownership, complete input and matching
dedup/attachment evidence, ordered by acceptance sequence rather than timestamps or IDs.
Missing input and legacy created/queued metadata are reported as `input_unavailable`.
Uploading/sending/running/cancel-requested and UNKNOWN are reported as
`reconciliation_required`; R2 leaves their states unchanged and never replays them.
Their remote keys block queued successors until future reconciliation. Independent
keys can still execute. Raw executor errors do not trigger retries or appear in diagnostics.

Retention A was approved on 2026-10-01: input remains throughout non-terminal processing
with no expiry; every terminal transition, including UNKNOWN, atomically deletes new R2
input and its working attachment metadata. Lifecycle, dedup, old request/mapping references
and legacy R1 metadata survive. `request_acceptances` retains only the request ID so cleanup
still recognizes R2 working references after input loss; surviving R2 input also proves
cleanup ownership after acceptance-record loss. Claim still requires both records.
If both artifacts are lost, automatic ownership classification is impossible.
The 0004 upgrade classifies existing
0003 input rows; it cannot reconstruct ownership already lost before upgrade without
external evidence. This is SQLite row deletion, not secure erasure of WAL or
backups. Actual temporary-file cleanup belongs to R5.

Shutdown rejects new admissions, stops dispatch, waits already active callbacks, and
retains pending input for restart. A crashed active callback remains blocked until R3
reconciliation. `bootstrap` remains the local one-shot maintenance command described above.

## R3 provider and request lifecycle

`RequestService` composes the existing queue/repositories with the application-owned
`ChatProvider`. Tests inject `FakeChatProvider`, a clock, result delivery and manual
barriers. Fake scenarios cover success, slow generation, pre-submit failure, ambiguous
send, failure after confirmed submission, timeout, cancellation, completion races,
provider unavailability and authentication requirements. No live sessions are used.

Evidence is validated and correlated to the exact request/remote identity. Partial text,
an exception or an acknowledged stop cannot prove completion. A local generation timeout
aborts observation, not remote generation: without terminal evidence it becomes UNKNOWN.
Unknown keys continue to block successors and reserve provider concurrency capacity.
Cancellation and completion are joined before the queue key is released. Result-delivery
failure cannot change a provider-completed request or trigger another prompt.
When their correlated terminal kinds differ, completed from either source wins; otherwise
awaitCompletion's terminal outcome has priority and cancel fills an unknown observation.

Startup resumes only fully evidenced queued input. It reconciles interrupted work through
read-only inspection, accepts correlated terminal evidence and otherwise records UNKNOWN.
There is no automatic retry, replay from UNKNOWN or resumption of interrupted observation.
Incomplete created/queued input remains blocked. Terminal settlement uses unchanged R2
retention; migrations 0001–0004 are unchanged. Callback delivery diagnostics are currently
in-memory in isolated callback-only tests. The R7 runtime supplies atomic result persistence,
durable delivery recovery and the explicit UNKNOWN resolution described above.

The provider port passes only generated attachment storage keys and display metadata.
R5 will resolve/download real files, and R6 will implement the actual browser adapter.
This is offline lifecycle evidence, not full Telegram/ChatGPT acceptance.
