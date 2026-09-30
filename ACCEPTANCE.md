# ACCEPTANCE.md

## 1. Purpose

This document defines externally observable acceptance criteria for the MVP.

Implementation details may change. A criterion passes only when its behavior is demonstrated by tests or reproducible evidence.

---

## 2. Global acceptance rules

### G1. No unrelated project dependency

The repository must run without NightReviewer or any other private project being installed, running, mounted or configured.

### G2. No OpenAI API dependency for generation

Normal message generation must use the configured ChatGPT Web provider path, not OpenAI API billing endpoints.

### G3. Fresh-install reproducibility

A clean machine with documented prerequisites must be able to reach the authentication/bootstrap state using only repository documentation and declared dependencies.

### G4. Secret-free evidence

Acceptance evidence must not include browser cookies, tokens, Telegram bot token, authorization headers or other session credentials.

---

# A. Bootstrap and authentication

## AC-A01 — Config validation

Given required configuration is incomplete,
when the application starts,
then it exits or remains non-ready with a stable `CONFIG_ERROR`,
and explains the missing configuration without printing secret values.

## AC-A02 — Telegram token validation

Given an invalid Telegram bot token,
when runtime initialization occurs,
then health is not `READY`,
and the failure is distinguishable from ChatGPT authentication failure.

## AC-A03 — ChatGPT authentication required

Given the persistent browser profile is not authenticated,
when provider health is checked,
then runtime reports `AUTH_REQUIRED`,
and no prompt is submitted.

## AC-A04 — Persistent browser authentication

Given the operator authenticates the dedicated browser profile,
when the service is stopped and started again,
then authentication remains available without copying cookies into application configuration or database.

---

# B. Authorization

## AC-B01 — Allowlisted user

Given Telegram user A is allowlisted,
when A sends `/start`,
then the bot responds normally.

## AC-B02 — Non-allowlisted user

Given Telegram user B is not allowlisted,
when B sends any command, text or attachment,
then no provider operation is performed,
and the response is access denied or intentionally silent according to configuration.

## AC-B03 — Authorization before file download

Given a non-allowlisted user sends a large attachment,
then the service must reject the interaction before downloading the file into local temporary storage.

---

# C. Conversation management

## AC-C01 — Create a named conversation

Given the provider is ready,
when the user sends `/new coding`,
then a real provider conversation is created or initialized,
a local alias `coding` is persisted,
and `coding` becomes the active conversation.

## AC-C02 — Auto-generated alias

When the user sends `/new` without an alias,
then a unique local alias is generated and returned.

## AC-C03 — Duplicate alias

Given alias `coding` already exists for the user,
when the user sends `/new coding`,
then no second mapping with the same alias is created,
and the bot returns a deterministic validation error.

## AC-C04 — Add existing conversation

Given the user has access to an existing ChatGPT Web conversation,
when the user sends `/add research <supported-reference>`,
then the provider verifies access,
and the local alias maps to that exact remote conversation.

## AC-C05 — Reject inaccessible conversation

Given the referenced conversation is unavailable or not accessible to the browser session,
when `/add` is used,
then no local ready mapping is created.

## AC-C06 — List conversations

Given at least two mappings exist,
when `/chats` is invoked,
then each alias is shown once,
and the currently active alias is identifiable.

## AC-C07 — Switch active conversation

Given aliases `coding` and `research`,
when `/use research` succeeds,
then subsequent ordinary messages target only `research` until changed.

## AC-C08 — Rename alias

When `/rename old new` succeeds,
then the provider conversation identifier remains unchanged.

## AC-C09 — Remove local mapping

When `/remove research` succeeds,
then the local mapping is removed or archived,
but the remote ChatGPT conversation is not deleted.

---

# D. Text messaging

## AC-D01 — Basic prompt round trip

Given an active ready conversation,
when the user sends `2+2?`,
then exactly one corresponding user prompt is submitted to that remote conversation,
and the completed assistant response is returned to Telegram.

## AC-D02 — Correct conversation

Given `coding` is active,
when a prompt is sent,
then no other registered conversation receives that prompt.

## AC-D03 — Final completion detection

The bot must not mark a request `COMPLETED` merely because partial assistant text appeared. Completion must be based on provider completion evidence.

## AC-D04 — Telegram response delivery failure

Given ChatGPT completes successfully but Telegram delivery fails,
then the request remains distinguishable as provider-completed with delivery failure; the service must not resubmit the prompt to ChatGPT as a retry strategy.

---

# E. Idempotency and queues

## AC-E01 — Duplicate Telegram update

Given the exact same Telegram update is delivered twice,
then at most one logical request is created,
and at most one provider prompt is submitted.

## AC-E02 — Same-conversation FIFO

Given three prompts are accepted quickly for one conversation,
then provider submission order is the same as accepted queue order.

## AC-E03 — One active request per conversation

At no observation point may two requests for the same canonical provider conversation be simultaneously in the provider submission/generation critical section.

## AC-E04 — Parallel different conversations

Given provider capability supports concurrent conversations,
a long-running request in `coding` does not prevent `research` from starting its own request.

## AC-E05 — Alias convergence

If two local aliases somehow point to the same canonical provider conversation identifier, they must share the same serialization key so concurrent mutation is still prevented.

---

# F. Crash and restart safety

## AC-F01 — Persist conversation mappings

After normal restart, registered aliases and active-selection state required by the product remain available.

## AC-F02 — Safe queued recovery

A request persisted as queued and proven not submitted may be requeued after restart.

## AC-F03 — Ambiguous sending state

If the process crashes during a state where provider submission may have happened but cannot be proven either way,
then the recovered request becomes `UNKNOWN` or equivalent,
and the service does not automatically submit it again.

## AC-F04 — Ambiguous running state

If a running request cannot be reliably correlated with provider state after restart,
then it is surfaced as ambiguous rather than blindly replayed.

## AC-F05 — No duplicate recovery submission

Restart recovery tests must demonstrate that ambiguity does not produce duplicate user prompts.

---

# G. Attachments

## AC-G01 — Supported text/source attachment

Given a supported source/text file within limits,
when it is sent with a prompt,
then the file reaches the provider request and the prompt is submitted once.

## AC-G02 — PDF attachment

Given a supported PDF within limits,
it can be uploaded and associated with the logical request.

## AC-G03 — Image attachment

Given a supported image within limits,
it can be uploaded and associated with the logical request.

## AC-G04 — Oversized attachment

Given a file exceeds configured maximum size,
it is rejected before provider submission.

## AC-G05 — Too many attachments

Given a request exceeds configured attachment count,
it is rejected deterministically.

## AC-G06 — Path safety

A Telegram-provided filename containing traversal syntax cannot cause writes outside the configured temporary directory.

## AC-G07 — Cleanup

Temporary local copies are removed after successful processing or by bounded TTL cleanup after failure.

---

# H. Cancellation

## AC-H01 — Stop active generation

Given a request is actively generating and provider cancellation is supported,
when `/stop` is invoked for that conversation,
then cancellation is requested and the final local state becomes `CANCELLED`, `COMPLETED`, or `UNKNOWN` based on provider evidence.

## AC-H02 — Stop with nothing running

When `/stop` is invoked with no active request,
the response is deterministic and no provider mutation occurs.

## AC-H03 — Queued requests are preserved

Stopping the active request must not silently delete later queued requests unless the product explicitly offers a separate queue-clear command.

---

# I. Rendering and Telegram limits

## AC-I01 — Long answer chunking

A provider response larger than Telegram message limits is delivered as an ordered sequence of messages without data loss.

## AC-I02 — Code blocks

A long fenced code block remains readable. If it must be split, each resulting Telegram chunk remains syntactically safe for the chosen rendering mode.

## AC-I03 — Parse fallback

If rich Markdown rendering fails, the system retries delivery as safe plain text rather than dropping the answer.

---

# J. Health and diagnostics

## AC-J01 — Ready state

`READY` may be reported only when required local services, database, Telegram transport and provider prerequisites are actually ready for a normal accepted request.

## AC-J02 — Browser unavailable

If the browser/provider process is unavailable, `/status` must not report `READY`.

## AC-J03 — Authentication unavailable

If ChatGPT authentication is missing, `/status` or doctor output distinguishes `AUTH_REQUIRED` from generic browser failure.

## AC-J04 — Read-only doctor

Running `doctor` must not create a ChatGPT conversation, submit a prompt, upload a file or otherwise mutate user conversations.

---

# K. Security and observability

## AC-K01 — Token redaction

Repository tests or fixtures demonstrate that known secret keys/values are redacted from logs.

## AC-K02 — Prompt logging default

By default, full prompt and response content are not written to ordinary application logs.

## AC-K03 — Request trace

For a completed request, logs/evidence can correlate:

```text
Telegram update -> requestId -> conversationId -> provider operation -> Telegram delivery
```

without exposing authentication secrets.

## AC-K04 — No browser auth in database

Database inspection shows no ChatGPT cookies, local-storage auth tokens or authorization headers.

---

# L. Definition of acceptance evidence

For every mandatory criterion, provide one of:

- automated test name + passing output;
- integration test + sanitized receipt;
- deterministic manual reproduction steps + sanitized observed result.

Statements such as "implemented" or "should work" are not acceptance evidence.