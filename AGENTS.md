# AGENTS.md

## 1. Mission

Build and maintain the standalone TG WebGPT Gateway described by:

1. `PRODUCT.md`
2. `ARCHITECTURE.md`
3. `ACCEPTANCE.md`
4. `ROADMAP.md`

These documents are authoritative for product scope, architecture, acceptance and implementation order.

If code and documentation conflict, do not silently choose one. Determine whether the code is incomplete or the specification is outdated, then make the smallest justified correction and record the reason.

---

## 2. Required read order before changes

Before starting a new task, read:

1. `PRODUCT.md` — what is being built and what is out of scope;
2. `ARCHITECTURE.md` — boundaries and invariants;
3. `ACCEPTANCE.md` — externally provable behavior;
4. `ROADMAP.md` — current implementation order;
5. relevant source/tests for the requested task.

Do not begin by editing files after reading only the task title.

---

## 3. Core restrictions

### R1 — Standalone only

Do not import, copy runtime state from, depend on, or mutate NightReviewer or any unrelated private project.

### R2 — No architecture shortcuts

Telegram may not drive browser automation directly.

Provider/browser-specific logic belongs behind `ChatProvider`.

### R3 — No blind retry across ambiguous submission

Never automatically re-submit a request if provider submission may already have occurred.

### R4 — Serialize one remote conversation

Never allow two active provider mutations for the same canonical remote conversation.

### R5 — Preserve idempotency

Do not introduce any path where one Telegram update can create two provider prompts.

### R6 — Protect secrets

Never print or commit:

- Telegram bot token;
- ChatGPT cookies;
- browser local-storage tokens;
- authorization headers;
- session tokens;
- full browser profile contents.

### R7 — No opportunistic scope expansion

Do not add agent orchestration, RAG, REST APIs, Web UI, voice, streaming, schedulers or multi-account support unless the active task explicitly requires it.

---

## 4. Decision policy

Make local implementation decisions only when all of the following are true:

- they do not change product scope;
- they do not weaken an architectural invariant;
- they do not change a public command/behavior defined in acceptance criteria;
- they are reversible implementation details;
- there is enough evidence in the repository/dependency documentation.

Raise a decision request instead of guessing when a choice affects:

- provider semantics;
- request replay/recovery behavior;
- authentication storage;
- security boundary;
- canonical conversation identity;
- exact upstream/runtime compatibility when undocumented;
- destructive remote behavior;
- MVP scope.

A decision request must include:

```text
Question
Why the decision is required now
Evidence
Options
Consequences of each option
Recommended default only if evidence strongly supports it
Blocked work
```

Do not manufacture certainty.

---

## 5. Change strategy

Prefer the smallest complete change that advances the current roadmap phase.

For each task:

1. inspect current state;
2. identify exact acceptance criteria/invariants affected;
3. write or update tests first when practical;
4. implement minimally;
5. run focused tests;
6. run broader verification required by touched boundaries;
7. inspect diff for scope creep and secret leakage;
8. update documentation only when behavior/architecture genuinely changed.

Do not perform unrelated cleanup in the same task.

---

## 6. Testing rules

### Mandatory

Every behavior change requires evidence.

Prefer automated tests for:

- request state transitions;
- queue behavior;
- idempotency;
- recovery;
- redaction;
- command parsing;
- persistence;
- rendering/chunking.

### Live provider tests

Live ChatGPT integration tests must be explicitly opt-in.

Normal unit tests must not require:

- internet;
- Telegram network;
- live ChatGPT;
- real browser login.

Use fakes for deterministic core behavior.

---

## 7. Provider integration rules

All `codex-chatgpt-web`-specific code stays in its provider adapter/module.

Do not expose to application/domain code:

- DOM selectors;
- browser page objects;
- Playwright/native browser types;
- upstream internal message types;
- raw session credentials.

Normalize upstream errors to application error codes.

If upstream behavior cannot distinguish pre-submit failure from potentially submitted state, choose safety: mark ambiguity rather than retry.

---

## 8. Persistence and migrations

Never edit an already-applied production migration destructively just to make tests pass.

Add forward migrations.

Persistence changes must include tests for:

- fresh database;
- upgraded database when relevant;
- restart behavior;
- constraints relied upon for correctness.

---

## 9. Logging and evidence

Logs should be useful without containing content or secrets by default.

Before presenting evidence, redact:

- tokens;
- cookies;
- auth headers;
- session identifiers that grant access;
- private file contents not necessary to prove behavior.

Do not paste full prompts/responses when state transitions or hashes are sufficient evidence.

---

## 10. Git discipline

Unless explicitly authorized otherwise:

- do not force-push;
- do not rewrite shared history;
- do not delete branches/tags unrelated to the task;
- do not merge unreviewed changes merely because tests pass;
- do not commit secrets or local browser profiles;
- inspect `git status` and diff before finalizing.

Generated runtime/profile/temp/database files must be ignored unless they are intentional sanitized fixtures.

---

## 11. Completion report

When a task is finished, report concisely:

```text
Task
Result
Files changed
Acceptance/invariants covered
Tests executed + result
Known limitations
Decisions still needed
```

Do not claim full MVP completion unless `ACCEPTANCE.md` has been executed and passed.

---

## 12. Stop conditions

Stop modifying code and surface the issue when:

- a required architectural decision lacks evidence;
- proceeding would require exposing or copying credentials;
- the requested action conflicts with an invariant;
- the task would depend on another private project;
- the only available recovery behavior risks duplicate provider submission;
- the repository state differs materially from the assumptions in the task and the difference changes correctness.

When stopped, preserve the repository in a valid state and provide exact evidence and the minimum decision needed to continue.