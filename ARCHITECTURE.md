# ARCHITECTURE.md

## 1. Architecture objective

Build a standalone Telegram-to-ChatGPT-Web gateway where browser automation is isolated behind an application-owned provider boundary.

The architecture must prioritize request identity, serialization, crash safety and secret isolation over convenience abstractions.

---

## 2. Context diagram

```text
┌──────────────────┐
│ Telegram Client  │
└────────┬─────────┘
         │ Telegram Bot API
         ▼
┌──────────────────┐
│ Telegram Adapter │
└────────┬─────────┘
         │ commands / messages / files
         ▼
┌────────────────────────────────────────┐
│ Application Core                       │
│                                        │
│ ConversationService                    │
│ RequestService                         │
│ AttachmentService                      │
│ HealthService                          │
└──────────────┬─────────────────┬───────┘
               │                 │
               ▼                 ▼
      ┌────────────────┐   ┌──────────────┐
      │ Queue Manager  │   │ Persistence  │
      │ per conv. FIFO │   │ SQLite       │
      └───────┬────────┘   └──────────────┘
              │
              ▼
      ┌──────────────────┐
      │ ChatProvider     │
      │ interface        │
      └────────┬─────────┘
               ▼
      ┌──────────────────────┐
      │ ChatGPT Web Adapter  │
      │ codex-chatgpt-web    │
      └────────┬─────────────┘
               ▼
      ┌──────────────────────┐
      │ Persistent Browser   │
      │ Profile              │
      └────────┬─────────────┘
               ▼
          chatgpt.com
```

---

## 3. Dependency rule

Dependencies point inward.

```text
Telegram -> Application <- Provider Adapter
                  |
                  v
              Domain
```

Forbidden dependencies:

- domain -> Telegram;
- domain -> Playwright/browser library;
- application -> DOM selectors;
- application -> provider-specific response structures;
- provider adapter -> Telegram;
- persistence -> Telegram formatting.

---

## 4. Recommended modules

```text
src/
  domain/
    Conversation.ts
    Request.ts
    Message.ts
    Attachment.ts
    Health.ts
    errors.ts

  application/
    ConversationService.ts
    RequestService.ts
    AttachmentService.ts
    HealthService.ts
    DoctorService.ts

  ports/
    ChatProvider.ts
    ConversationRepository.ts
    RequestRepository.ts
    UpdateDedupRepository.ts
    AttachmentStore.ts

  providers/
    chatgpt-web/
      ChatGptWebProvider.ts
      ChatGptWebSession.ts
      ProviderStateMapper.ts
      ProviderErrorMapper.ts

  transports/
    telegram/
      TelegramBot.ts
      TelegramCommands.ts
      TelegramMessageHandler.ts
      TelegramRenderer.ts
      TelegramFileCollector.ts

  queue/
    ConversationQueue.ts
    QueueCoordinator.ts

  persistence/
    sqlite/
      Database.ts
      migrations/
      SqliteConversationRepository.ts
      SqliteRequestRepository.ts
      SqliteUpdateDedupRepository.ts

  runtime/
    RuntimeController.ts
    RecoveryCoordinator.ts
    SignalHandlers.ts

  config/
    Config.ts
    schema.ts

  logging/
    logger.ts
    redaction.ts

  cli/
    index.ts
    status.ts
    doctor.ts

  main.ts
```

Exact file names may vary. Dependency boundaries may not.

---

## 5. Core domain entities

### Conversation

```ts
type ConversationId = string;

type Conversation = {
  id: ConversationId;
  telegramUserId: string;
  alias: string;
  providerConversationId: string;
  providerUrl?: string;
  status: 'ready' | 'unavailable' | 'unknown';
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  archived: boolean;
};
```

`providerConversationId` is opaque to the application core.

### Request

```ts
type RequestState =
  | 'created'
  | 'queued'
  | 'uploading'
  | 'sending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancel_requested'
  | 'cancelled'
  | 'timeout'
  | 'unknown';

type Request = {
  id: string;
  conversationId: string;
  telegramUpdateId: string;
  telegramMessageId?: string;
  state: RequestState;
  createdAt: string;
  startedAt?: string;
  submittedAt?: string;
  finishedAt?: string;
  providerRequestId?: string;
  failureCode?: string;
};
```

Important distinction:

- `startedAt`: local processing began;
- `submittedAt`: there is evidence the prompt crossed the provider submission boundary.

This distinction is required for safe crash recovery.

### Attachment

Store only operational metadata required for processing. Do not make the local copy canonical after upload.

---

## 6. Provider port

The application owns the interface.

Conceptual contract:

```ts
interface ChatProvider {
  health(): Promise<ProviderHealth>;

  createConversation(input?: {
    titleHint?: string;
  }): Promise<ProviderConversation>;

  inspectConversation(
    reference: ProviderConversationReference,
  ): Promise<ProviderConversation>;

  send(input: {
    conversationId: string;
    text?: string;
    attachments?: ProviderAttachmentInput[];
    clientRequestId: string;
  }): Promise<ProviderSubmission>;

  awaitCompletion(input: {
    conversationId: string;
    submission: ProviderSubmission;
    signal?: AbortSignal;
  }): Promise<ProviderAssistantMessage>;

  cancel(input: {
    conversationId: string;
    submission?: ProviderSubmission;
  }): Promise<ProviderCancelResult>;
}
```

The concrete adapter may need additional internal methods, but they must not leak into the application service API.

---

## 7. Provider evidence boundary

The adapter must expose enough information to distinguish:

1. failure before submission;
2. confirmed submission;
3. generation in progress;
4. confirmed completion;
5. confirmed cancellation;
6. unknown/ambiguous state.

The application must never infer "not submitted" merely because a response was not received.

---

## 8. Request lifecycle

Nominal path:

```text
CREATED
  -> QUEUED
  -> UPLOADING?   optional
  -> SENDING
  -> RUNNING
  -> COMPLETED
```

Failure paths:

```text
CREATED/QUEUED -> FAILED
UPLOADING      -> FAILED
SENDING        -> FAILED | UNKNOWN
RUNNING        -> FAILED | TIMEOUT | CANCELLED | UNKNOWN
```

A failure during `SENDING` is retryable automatically only when the provider can prove that submission did not occur.

---

## 9. Exactly-once-like submission strategy

True distributed exactly-once semantics are not assumed.

The product instead enforces:

### A. Telegram ingress idempotency

Persist the Telegram `update_id` or equivalent stable deduplication key before creating another logical request.

Invariant:

```text
one Telegram update -> at most one logical Request
```

### B. Stable application request identity

Every request receives a durable `requestId` before provider submission.

### C. Serialized remote conversation mutation

Only one request can cross the provider submission boundary for a given remote conversation at a time.

### D. Ambiguity is explicit

After a crash, if a request had potentially crossed the submission boundary but completion cannot be proven, state becomes `UNKNOWN`. It is not auto-replayed.

---

## 10. Queue architecture

Keyed FIFO queue by canonical provider conversation identity within the single MVP
provider/profile. Local mapping IDs and aliases are not serialization keys: two
mappings may reference one remote conversation (AC-E05). R1 exposes the exact opaque
`providerConversationId` as that key. R2's `RequestQueue` executes accepted work through
an injected callback; the callback spans the full mutation and persists its final
lifecycle evidence before resolving. The actual provider contract belongs to R3.

```text
conv-A: req-1 RUNNING -> req-2 QUEUED -> req-3 QUEUED
conv-B: req-4 RUNNING -> req-5 QUEUED
```

Invariants:

```text
runningRequests(canonicalProviderConversationId) <= 1
```

and, when provider capability allows:

```text
runningRequests(global) may be > 1
```

If the concrete provider uses a single browser page that cannot safely execute multiple conversations concurrently, the provider adapter may temporarily expose a lower global concurrency capability. The application queue should not hardcode browser limitations.

---

## 11. Concurrency capability

Provider health/capabilities should expose something equivalent to:

```ts
type ProviderCapabilities = {
  concurrentConversations: boolean;
  cancellation: boolean;
  fileUpload: boolean;
};
```

The scheduler respects these capabilities.

R2 receives a positive `maxConcurrentConversations` limit explicitly; 1 serializes
all keys, larger limits permit independent keys to run concurrently. R3 will derive
that limit from provider capabilities. There is one queue runtime for the MVP database;
multi-process scheduling/notifications are not implemented.

Pending capacity counts `created`/`queued` requests across all mappings for the exact
provider ID, including blocked work. Active processing does not consume a pending slot.
Admission checks duplicates before capacity. `QUEUE_FULL` does not create a request,
payload or dedup marker. Shutdown closes admission and dispatch, waits for active
callbacks, and preserves queued input for the next runtime; it does not cancel remote work.

---

## 12. Persistence

SQLite is sufficient for MVP.

Minimum tables:

### users

```text
telegram_user_id PK
enabled
created_at
```

### conversations

```text
id PK
telegram_user_id
alias
provider_conversation_id
provider_url
status
created_at
updated_at
last_used_at
archived
UNIQUE(telegram_user_id, alias) WHERE archived=0
```

The alias constraint is a partial unique index: `/remove` frees the visible name while
archived rows retain their original ID/alias/provider identity and request references.
Rename/archive repository contracts require the owner ID and enforce it in the same SQL
statement that mutates the mapping. A denied archive must not clear active selection.

### requests

```text
id PK
conversation_id
telegram_update_id
telegram_message_id
state
provider_request_id
created_at
started_at
submitted_at
finished_at
failure_code
failure_detail_redacted
```

R1 persists normalized `failure_code` only. Optional free-form redacted details require
a trusted error mapper and a forward migration in a later phase; raw upstream errors
are never accepted by the R1 repository contract.

### active_conversations

```text
telegram_user_id PK -> users
conversation_id
FK(telegram_user_id, conversation_id) -> conversations(telegram_user_id, id)
```

This selection is durable for AC-F01. The repository permits selection only of an
unarchived mapping owned by that user, and archives/clears selection atomically.
An archived mapping remains available for historical request metadata.

### processed_updates

```text
telegram_update_id PK
request_id NULLABLE
processed_at
```

### attachments

Operational metadata only.

### request_inputs (R2, forward migration 0003)

```text
sequence INTEGER PRIMARY KEY AUTOINCREMENT
request_id UNIQUE -> requests
payload { text?, attachmentIds[] }
```

The sequence records committed acceptance order independent of timestamps or request IDs;
it is not reused after deleting terminal input. Attachment values remain solely in
`attachments`; the ID array preserves the user's accepted attachment order.
`SqliteRequestQueueRepository` composes the existing adapters on one connection in
`BEGIN IMMEDIATE`: duplicate lookup, capacity check, request/attachments/input creation,
durable acceptance ownership, processed-update marker and `created -> queued` commit
together or roll back together.
Only authorized, resolved mapping inputs should reach this application boundary; the
future Telegram adapter owns the allowlist and command routing.

`SqliteRequestRepository.transition` implements approved retention A: terminal lifecycle
update, R2 attachment deletion and input deletion share the same transaction. It retains
requests, dedup markers and mapping references, and leaves legacy R1 attachments unchanged.
Retention ownership comes from `request_acceptances`, independent of the deletable input.
No trigger support or migration-language extension is needed. This is logical SQLite
row deletion, not secure erasure of WAL, freed pages or separately retained backups.

### request_acceptances (R2, forward migration 0004)

This table stores only a primary/foreign key `request_id -> requests`: durable R2
retention ownership with no text or working attachment references. Acceptance writes
it in the same transaction; it remains after input deletion. Terminal cleanup therefore
removes R2 attachments even if the payload row was lost, without reclassifying legacy
R1 metadata. 0004 backfills only requests with an existing 0003 input row. If that input
was already lost before upgrade, no surviving ownership evidence exists: automated
classification is deliberately not inferred from timestamps, IDs or attachment names.

---

## 13. Restart recovery

At startup:

1. initialize configuration;
2. open/migrate database;
3. inspect non-terminal requests;
4. initialize provider;
5. obtain provider health;
6. reconcile each non-terminal request conservatively;
7. only then accept new Telegram traffic.

Suggested reconciliation:

- `CREATED`/`QUEUED`: safe to requeue if no provider submission attempt exists;
- `UPLOADING`: cleanup temporary state and retry according to attachment policy if submission did not begin;
- `SENDING`: mark `UNKNOWN` unless provider can prove no submission;
- `RUNNING`: query provider if correlation is reliable; otherwise mark `UNKNOWN`;
- `CANCEL_REQUESTED`: reconcile to `CANCELLED`, `COMPLETED`, or `UNKNOWN` based on evidence.

No automatic replay from `UNKNOWN`.

R2 performs only safe queue reconstruction, before R3 reconciliation exists. A consistent
read snapshot checks queued lifecycle, durable acceptance ownership, input, exact ordered attachment set and the
originating dedup marker. Missing/invalid input or incomplete acceptance evidence is
surfaced as `input_unavailable`; it is never replaced with an empty prompt. Legacy
created/queued metadata alone cannot be reconstructed.

Uploading/sending/running/cancel-requested work and UNKNOWN are surfaced as
`reconciliation_required`. They are neither replayed nor rewritten by R2. Every such
remote key blocks its queued successors, while independent keys may run. SQL claim
rechecks key blockers and the first accepted request under `BEGIN IMMEDIATE`, then
persists `uploading` (attachments) or `sending` (text only) before invoking the callback.
Executor rejection does not imply a pre-submit failure or schedule a retry. An unsettled
durable lifecycle keeps the key blocked. Request failure classification, provider
evidence provenance and resolution of these blocks belong to R3/R7.

---

## 14. Telegram transport

Telegram adapter responsibilities:

- authorize sender against allowlist;
- parse commands;
- collect text/files;
- deduplicate updates;
- map Telegram interaction to application commands;
- render application results safely;
- split oversized responses;
- manage temporary progress messages.

Telegram adapter must not:

- know browser selectors;
- open ChatGPT URLs directly;
- decide provider retries;
- mutate SQLite directly outside repositories;
- store browser authentication data.

---

## 15. Markdown rendering

Introduce an explicit renderer:

```text
provider markdown-ish response
    -> normalized message model
    -> Telegram-safe renderer
    -> chunks
```

Chunking priority:

1. heading/section boundary;
2. paragraph;
3. fenced code block as an atomic unit where possible;
4. sentence;
5. hard byte/character boundary only as a last resort.

Telegram parse errors should fall back to plain text rather than losing the answer.

---

## 16. Attachment flow

```text
Telegram file
  -> authorize
  -> validate metadata
  -> download to isolated temp path
  -> validate actual size/type policy
  -> provider upload
  -> provider send
  -> cleanup temp file
```

Security requirements:

- generated temp filename; do not trust remote filename as a path;
- no path traversal;
- bounded size;
- bounded count;
- no arbitrary local file path command in MVP.

---

## 17. Authentication model

ChatGPT authentication exists exclusively inside a dedicated persistent browser profile.

Forbidden:

- copying cookies into `.env`;
- persisting auth headers in SQLite;
- returning cookies/tokens through `/status` or `/doctor`;
- logging browser storage state.

The operator may need one interactive local login bootstrap.

---

## 18. Health model

Runtime state:

```text
STARTING
READY
DEGRADED
AUTH_REQUIRED
ERROR
STOPPING
```

Provider health should contain normalized booleans/state such as:

```ts
type ProviderHealth = {
  processRunning: boolean;
  browserConnected: boolean;
  chatgptReachable: boolean;
  authenticated: boolean;
  ready: boolean;
  state: string;
  observedAt: string;
};
```

`/status` returns concise user-facing state.

`doctor` returns more diagnostics but still redacts secrets.

---

## 19. Error taxonomy

Normalize provider/transport exceptions into stable application codes:

```text
AUTH_REQUIRED
UNAUTHORIZED_TELEGRAM_USER
BROWSER_UNAVAILABLE
PROVIDER_UNAVAILABLE
CHAT_NOT_FOUND
CHAT_ACCESS_DENIED
INVALID_CONVERSATION_REFERENCE
ATTACHMENT_REJECTED
UPLOAD_FAILED
SEND_FAILED_PRE_SUBMIT
SUBMISSION_STATE_UNKNOWN
GENERATION_TIMEOUT
GENERATION_CANCELLED
TELEGRAM_DELIVERY_FAILED
DATABASE_ERROR
CONFIG_ERROR
```

Do not expose raw browser stack traces to Telegram users.

---

## 20. Logging

Structured logs should include when available:

```text
timestamp
level
requestId
telegramUpdateId
telegramUserId
conversationId
conversationAlias
operation
requestState
providerState
durationMs
errorCode
```

Default:

```text
LOG_CONTENT=false
```

A central redaction function must remove known secret-like keys and values.

---

## 21. Configuration

Configuration must be validated at startup.

Conceptual example:

```yaml
telegram:
  allowedUsers:
    - "123456789"

provider:
  type: chatgpt-web

browser:
  profileDir: ./data/browser-profile

requests:
  generationTimeoutMs: 600000

queue:
  maxPendingPerConversation: 20

attachments:
  tempDir: ./data/tmp
  maxFilesPerRequest: 10
  maxFileSizeBytes: 52428800

streaming:
  enabled: false

logging:
  content: false
```

Secrets such as Telegram bot token should come from environment/secret storage, not committed configuration.

---

## 22. Runtime/toolchain decision gate

Do not guess the exact runtime version for `codex-chatgpt-web` integration.

Before implementation of the provider adapter:

1. inspect the selected upstream revision/documentation;
2. determine its documented runtime/toolchain;
3. pin an exact compatible version in this repository;
4. record the decision in an ADR or lock/toolchain file;
5. if upstream requirements are ambiguous, raise a decision request instead of silently choosing an incompatible runtime.

This decision is local to this standalone repository.

---

## 23. Testing architecture

### Unit tests

- domain transitions;
- queue serialization;
- deduplication;
- command parsing;
- Markdown chunking;
- retry classification;
- redaction.

### Persistence tests

- uniqueness constraints;
- migrations;
- restart recovery states;
- dedup durability.

### Provider contract tests

Against a fake provider:

- pre-submit failure;
- confirmed submission;
- completion;
- cancellation;
- timeout;
- unknown submission state.

### Provider integration tests

Against the real selected provider in an explicitly marked integration environment.

Do not make normal unit tests depend on live ChatGPT.

---

## 24. Architectural invariants

### I1

Telegram transport does not depend on browser automation implementation details.

### I2

Application/domain code does not import Telegram SDK types.

### I3

Application/domain code does not import Playwright/browser/provider-native types.

### I4

At most one running/submitting request exists per canonical remote conversation.

### I5

A Telegram update creates at most one logical request.

### I6

An ambiguous post-crash submission is never silently replayed.

### I7

Browser authentication material never enters normal persistence or logs.

### I8

Removing a local conversation mapping does not delete the remote ChatGPT conversation.

### I9

Provider adapter can be replaced without changing core application behavior.

### I10

Every request crossing the provider boundary has a durable local `requestId` created first.

---

## 25. Architecture review checklist

Before merging any feature, verify:

- does this introduce Telegram details into the core?
- does this introduce provider/DOM details into the core?
- can a duplicate external event duplicate a prompt?
- can a crash cause unsafe replay?
- can two workers mutate the same remote conversation concurrently?
- can any secret appear in logs/status/errors?
- is the new failure mode mapped to a stable error code?
- is recovery behavior explicit and tested?
