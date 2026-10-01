# ROADMAP.md

## 1. Execution strategy

Implement from the inside out.

Do not begin with Telegram UX or browser DOM automation. First establish durable domain state, idempotency, queue semantics and provider contracts. Browser integration comes only after the application can be tested against a fake provider.

Each phase must leave the repository in a runnable/testable state.

---

# R0 — Repository bootstrap

## Goal

Create the smallest stable project shell with deterministic local tooling.

## Work

- initialize standalone repository structure;
- add formatting/lint/test commands;
- add configuration schema;
- add structured logger + secret redaction skeleton;
- add SQLite migration mechanism;
- add CI or local verification command;
- add `.env.example` containing names but no secrets;
- add basic README bootstrap instructions;
- inspect chosen `codex-chatgpt-web` upstream revision and document its runtime requirements;
- pin exact compatible toolchain/runtime for this repository.

## Decision gate R0-D1

If the upstream runtime requirement is ambiguous, do not guess. Produce a concise decision request with evidence from upstream files/docs.

## Exit criteria

- clean install works;
- unit test command works;
- database can initialize;
- configuration rejects missing required values;
- no runtime dependency on unrelated projects.

---

# R1 — Domain and persistence

## Goal

Establish durable concepts before external integration.

## Work

Implement:

- `Conversation`;
- `Request`;
- request state transitions;
- conversation repository;
- request repository;
- processed Telegram update repository abstraction;
- attachment metadata model;
- migrations;
- unique `(telegramUserId, alias)` constraint;
- canonical provider conversation identity.

## Tests

- valid/invalid state transitions;
- repository round trips;
- uniqueness;
- migration reproducibility;
- persistence across process restart simulation.

## Exit criteria

Domain/application code contains no Telegram SDK or browser/provider imports.

---

# R2 — Idempotency and keyed queue

## Prerequisite: durable operational payload

Before implementing restart-safe queue reconstruction, define persistence and retention
for the accepted request input (text and attachment references). Lifecycle metadata alone
cannot reconstruct a queued prompt. Add the next forward migration or an explicitly durable
payload store; this data is operational input, not a second canonical conversation history.
R1 does not implement this prerequisite or queue execution.

## Goal

Make duplicate input and same-conversation concurrency safe before any live provider work.

## Work

- durable deduplication service;
- keyed FIFO queue;
- canonical queue key based on provider conversation identity where available;
- one active request per canonical remote conversation;
- queue capacity limits;
- graceful shutdown behavior.

## Tests

- duplicate update -> one request;
- FIFO ordering;
- concurrent submissions to same key serialize;
- different keys can run concurrently;
- two aliases for one provider conversation share lock key;
- queue survives/reconstructs safe queued requests after restart.

## Exit criteria

Acceptance criteria AC-E01..E05 are demonstrable against in-memory/fake provider infrastructure.

---

# R3 — Provider contract with fake implementation

## Goal

Finalize application behavior without relying on a real browser.

## Work

- define `ChatProvider` port;
- implement deterministic `FakeChatProvider`;
- model capabilities;
- model provider health;
- implement request service end-to-end against fake provider;
- distinguish pre-submit failure from ambiguous post-submit failure;
- implement cancellation contract;
- implement restart reconciliation rules.

## Fake scenarios

- success;
- slow generation;
- pre-submit failure;
- confirmed submit then failure;
- timeout;
- cancellation success;
- cancellation race with completion;
- provider unavailable;
- authentication required.

## Exit criteria

Core request lifecycle can be fully tested without Telegram and without ChatGPT Web.

---

# R4 — Telegram transport

## Goal

Add Telegram as an adapter to the already-tested application core.

## Work

Implement:

- allowlist guard;
- `/start`;
- `/help`;
- `/new`;
- `/add`;
- `/chats`;
- `/use`;
- `/current`;
- `/rename`;
- `/remove`;
- `/status`;
- `/stop`;
- ordinary text handling;
- durable update deduplication integration;
- progress messages;
- safe renderer;
- long-response splitting.

Use `FakeChatProvider` for transport tests.

## Exit criteria

Telegram behavior can be tested without the real browser provider.

---

# R5 — Attachments

## Goal

Introduce bounded, secure Telegram file handling.

## Work

- authorization before download;
- temp storage abstraction;
- generated safe paths;
- size/count/type validation;
- text/source/PDF/image support where provider contract allows;
- multi-file logical request aggregation;
- cleanup on completion/failure;
- TTL cleanup job executed locally without user-visible scheduling semantics.

## Exit criteria

AC-G01..G07 pass against fake provider plus file-system integration tests.

---

# R6 — Real ChatGPT Web provider

## Goal

Integrate selected `codex-chatgpt-web` revision behind the provider boundary.

## Work

- dedicated persistent browser profile directory;
- provider process/session lifecycle;
- health mapping;
- auth-required detection;
- create conversation;
- inspect/register existing conversation;
- text send;
- attachment upload;
- reliable completion detection;
- cancellation if supported;
- normalized provider errors;
- sanitized diagnostics;
- capability detection for concurrent conversations.

## Critical restriction

Do not spread browser selectors or provider-native data structures outside `providers/chatgpt-web`.

## Integration tests

Use a clearly opt-in integration test profile. Unit test suite must remain offline from live ChatGPT.

## Exit criteria

AC-A03/A04, C01/C04/C05, D01/D03 and relevant health criteria pass with real provider evidence.

---

# R7 — Recovery and operational hardening

## Goal

Make abnormal execution safe.

## Work

- startup reconciliation of non-terminal requests;
- signal handling;
- bounded retry policy;
- `UNKNOWN` state UX;
- no replay of ambiguous send/running states;
- Telegram-delivery retry that never resubmits provider prompt;
- provider recovery state machine;
- read-only `doctor`;
- structured status output;
- log redaction tests;
- database backup/migration notes;
- temporary file cleanup at startup.

## Failure injection tests

Terminate process during:

- queued;
- uploading;
- pre-submit send;
- ambiguous send boundary;
- running generation;
- post-completion/pre-Telegram-delivery.

## Exit criteria

AC-F01..F05 and J/K criteria pass with evidence.

---

# R8 — MVP acceptance pass

## Goal

Prove the product rather than add features.

## Work

- execute every mandatory criterion in `ACCEPTANCE.md`;
- collect sanitized evidence;
- fix gaps;
- verify clean installation from README;
- verify no dependency on unrelated projects;
- verify secrets are absent from repository/history/artifacts to the extent locally testable;
- tag the first MVP-ready revision only after acceptance passes.

## Exit criteria

All mandatory acceptance criteria pass.

---

# Post-MVP backlog

These items must not block MVP and must not be implemented opportunistically unless explicitly requested:

- streaming edits in Telegram;
- REST transport;
- Web UI;
- Android client;
- multiple browser profiles/accounts;
- scheduled tasks;
- voice input;
- richer generated image/artifact handling;
- automatic agent orchestration;
- remote deployment hardening.

---

# Implementation ordering rule

Do not skip forward because a later feature is more visible.

Preferred order:

```text
R0 -> R1 -> R2 -> R3 -> R4 -> R5 -> R6 -> R7 -> R8
```

A phase may overlap only when its dependencies are already stable and tested.
