# TG WebGPT Gateway — R2 idempotency and keyed queue

This folder contains the bootstrap specification for a standalone Telegram gateway to browser-based ChatGPT via `codex-chatgpt-web` or a compatible provider adapter.

Read order:

1. `PRODUCT.md`
2. `ARCHITECTURE.md`
3. `ACCEPTANCE.md`
4. `ROADMAP.md`
5. `AGENTS.md`
6. `GOAL.md`

The repository includes the R0 shell, R1 domain/persistence and R2 durable acceptance
and keyed queue. R3 and later phases are not implemented. See
[R1 evidence](docs/verification/R1.md) and [R2 evidence](docs/verification/R2.md).

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
[ADR 0001](docs/adr/0001-r0-toolchain.md). `codex-chatgpt-web` is not a dependency.

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
bun --env-file=.env run start
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
| `GENERATION_TIMEOUT_MS` | `600000` |
| `MAX_PENDING_PER_CONVERSATION` | `20` |
| `ATTACHMENT_TEMP_DIR` | `./data/tmp` |
| `ATTACHMENT_MAX_FILES_PER_REQUEST` | `10` |
| `ATTACHMENT_MAX_FILE_SIZE_BYTES` | `52428800` |
| `LOG_LEVEL` | `info`; also accepts `debug`, `warn`, `error` |
| `LOG_CONTENT` | `false`; Boolean values must be `true` or `false` |

All numeric limits must be positive safe integers. Relative paths resolve from the
working directory. R2 consumes the pending queue limit when a queue runtime is composed;
the one-shot bootstrap does not run a queue. Generation/attachment limits are for future
phases. `LOG_CONTENT` is validated,
but ordinary R0 logs have no prompt/response fields even when it is `true`.

## Bootstrap and database

`start` is a **one-shot local bootstrap**, not a running bot. It checks the toolchain,
validates configuration, initializes/migrates SQLite, logs `bootstrap.complete` and
closes the connection. Success exits 0; it never reports `READY`. `LOG_LEVEL=warn`
or `error` suppresses the informational success log.

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

R2 includes no Telegram transport, `ChatProvider`, browser integration,
or doctor/status implementation. Compatibility
with arbitrary existing ChatGPT conversations remains unproven and must be resolved
before real provider integration.

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
`unknown`, which has no replay transition. Cancellation races can settle as completed,
cancelled or unknown. Reopening storage preserves states without provider reconciliation.
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
single runtime with explicit pending/global concurrency limits; R3 will supply the real
request-service callback and derive concurrency from provider capability. The callback
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
still recognizes R2 working references after input loss. The 0004 upgrade classifies existing
0003 input rows; it cannot reconstruct ownership already lost before upgrade without
external evidence. This is SQLite row deletion, not secure erasure of WAL or
backups. Actual temporary-file cleanup belongs to R5.

Shutdown rejects new admissions, stops dispatch, waits already active callbacks, and
retains pending input for restart. A crashed active callback remains blocked; R3/R7 own
provider reconciliation. `start` remains the local one-shot bootstrap described above.
