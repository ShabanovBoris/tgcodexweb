# PRODUCT.md

## 1. Product name

Working name: **TG WebGPT Gateway**.

A standalone Telegram gateway for using an authenticated browser-based ChatGPT session through `codex-chatgpt-web` or a compatible provider adapter.

The product is not an OpenAI API client. Its primary value is remote access to existing and newly created ChatGPT Web conversations from Telegram while preserving the browser conversation as the canonical conversation state.

---

## 2. Problem

A user may have useful ChatGPT Web conversations, browser-only capabilities, files, project context, or workflows that are inconvenient to access from a phone or from Telegram.

A Telegram bot should provide a lightweight remote interface without requiring the user to recreate conversation context in another API client.

The difficult part is not Telegram. The difficult part is making browser-backed message delivery reliable enough that:

- a Telegram update is not submitted twice;
- a response is associated with the correct conversation;
- one conversation is not mutated concurrently by multiple requests;
- a crash does not cause unsafe automatic re-submission;
- browser authentication secrets never leak into Telegram, logs, or the application database.

---

## 3. Product goal

Provide a stable local service with the following user flow:

```text
Telegram message
    -> authenticated Telegram user
    -> selected logical conversation
    -> queued logical request
    -> browser ChatGPT conversation
    -> completed ChatGPT response
    -> Telegram reply
```

The basic operation must behave as close as possible to **exactly once submission** from the user's point of view.

---

## 4. Product boundaries

### In scope for MVP

- one standalone repository;
- Telegram bot transport;
- allowlisted Telegram users;
- persistent local state;
- persistent ChatGPT browser profile;
- provider adapter around `codex-chatgpt-web` or a compatible integration;
- creation of a new ChatGPT Web conversation;
- registration of an existing ChatGPT Web conversation;
- multiple named conversations per Telegram user;
- selecting the active conversation;
- sending text messages;
- sending supported file attachments;
- retrieving final assistant responses;
- cancelling an active generation when provider support exists;
- per-conversation FIFO serialization;
- parallel processing across different conversations when the provider safely allows it;
- idempotent Telegram update handling;
- restart-safe request persistence;
- structured health/status model;
- diagnostics command that does not submit a ChatGPT prompt;
- safe Markdown rendering and response chunking for Telegram;
- structured logs with secret redaction.

### Explicitly out of scope for MVP

- NightReviewer integration;
- reuse of any NightReviewer runtime, profile, configuration, database, bot or orchestration logic;
- OpenAI API generation;
- multi-agent orchestration;
- autonomous routing between ChatGPT conversations;
- RAG or vector databases;
- semantic memory beyond the ChatGPT conversation itself;
- public multi-tenant SaaS;
- billing;
- scheduled prompts and cron automation;
- voice transcription;
- full browser remote desktop;
- automatic deletion of remote ChatGPT conversations;
- model benchmarking or model-selection logic.

---

## 5. Core product principles

### P1. Standalone

The repository must be runnable independently. It must not import or depend on code, runtime assets, environment variables, storage, browser profiles, or operational state from unrelated projects.

### P2. Browser conversation is canonical

The ChatGPT Web conversation is the source of truth for conversational context. The local database stores mappings, request state and operational metadata, not a second authoritative copy of the entire conversation history.

### P3. Telegram is a transport

Telegram-specific concerns must not leak into the application core or browser provider implementation.

### P4. Provider is replaceable

`codex-chatgpt-web` integration must sit behind an application-owned provider interface. The application core must not know DOM selectors, browser automation details or provider-specific URLs.

### P5. Safety over optimistic retry

If the application cannot prove that an interrupted request was not submitted, it must not blindly resubmit it.

### P6. One active generation per remote conversation

Requests targeting the same ChatGPT conversation are serialized.

### P7. Secret isolation

Browser session cookies, tokens, authorization headers and profile data never enter Telegram messages, normal logs or the application database.

---

## 6. Primary user stories

### US-01: Start the bot

As an allowlisted user, I can open the Telegram bot and see its current readiness and available commands.

### US-02: Create a conversation

As a user, I can create a new named logical chat from Telegram. The service creates or binds a real ChatGPT Web conversation and selects it.

### US-03: Attach an existing conversation

As a user, I can register an existing ChatGPT Web conversation URL or supported conversation identifier and assign it a local alias.

### US-04: List conversations

As a user, I can list my known aliases, see which one is active, and see basic operational state.

### US-05: Switch conversation

As a user, I can switch the active alias and have subsequent ordinary Telegram messages go to that conversation only.

### US-06: Send a text message

As a user, I can send ordinary text and receive the completed ChatGPT answer in Telegram.

### US-07: Send files

As a user, I can send supported files with an optional caption/prompt and have them attached to the corresponding ChatGPT request.

### US-08: Queue messages safely

As a user, if I send multiple messages quickly to one conversation, they are processed in order without overlapping browser mutations.

### US-09: Work with multiple conversations

As a user, a long request in one conversation does not unnecessarily block a different conversation.

### US-10: Stop a generation

As a user, I can request cancellation of the active generation for the selected conversation when the underlying provider can cancel it.

### US-11: Survive restart

As a user, my conversation mappings and completed history metadata remain available after application restart. Ambiguous in-flight requests are surfaced rather than silently duplicated.

### US-12: Diagnose problems

As an operator, I can run a read-only doctor/status check that reports configuration, database, Telegram, browser profile, authentication and provider readiness without sending a ChatGPT message.

---

## 7. Telegram UX

Required commands for MVP:

```text
/start
/help
/new [alias]
/add <alias> <conversation-url-or-id>
/chats
/use <alias>
/current
/rename <old> <new>
/remove <alias>
/status
/stop
```

Recommended additional operator command:

```text
/doctor
```

Removing a local mapping releases its alias for the same user's later `/new` or `/add`.
An archived mapping retains its ID and request metadata references; reusing an alias
does not redirect old requests or delete the old remote conversation.

Normal text is treated as a prompt for the active conversation.

A Telegram reply to a previous bot answer remains a normal next message in the selected ChatGPT conversation. Telegram reply threading must not create an implicit new ChatGPT branch in MVP.

---

## 8. User-visible request states

The UX may simplify internal states, but users should be able to distinguish at least:

- queued;
- uploading;
- generating;
- completed;
- cancelled;
- failed;
- unknown after interrupted execution.

A typical interaction:

```text
User: review this function
Bot: queued
Bot: generating…
Bot: <final response>
```

Streaming partial tokens is not required for MVP.

---

## 9. File support

MVP should support at least:

- text files;
- Markdown;
- common source-code files;
- PDF;
- common image formats;
- ZIP when the provider supports it.

Configurable constraints:

- maximum attachment size;
- maximum number of files per logical request;
- allowed MIME types/extensions;
- temporary storage directory;
- temporary file TTL.

Temporary downloads must be removed after successful completion or after a bounded cleanup period.

---

## 10. Data ownership

Local storage owns:

- Telegram user authorization mapping;
- logical conversation aliases;
- remote conversation identifiers/URLs;
- request lifecycle metadata;
- Telegram update deduplication keys;
- attachment metadata required for processing;
- health/recovery metadata.

The browser profile owns:

- ChatGPT authentication state;
- cookies;
- browser session data.

The remote ChatGPT conversation owns:

- canonical conversational history;
- remote attachments and assistant responses.

---

## 11. Non-functional requirements

### Reliability

- no concurrent writes to one remote conversation;
- no blind retry of ambiguous submissions;
- duplicate Telegram delivery must not duplicate prompts;
- bounded retries for known transient pre-submit failures.

### Security

- allowlist before any privileged action;
- secret redaction in logs;
- no browser auth material in the database;
- no bot token in repository files;
- no arbitrary filesystem access from Telegram commands.

### Observability

Every logical request should be traceable with one internal `requestId` through:

```text
Telegram update -> application request -> provider operation -> Telegram response
```

### Maintainability

Provider-specific code must be replaceable without editing domain/application logic.

---

## 12. Success criteria

The MVP is successful when a fresh local installation can:

1. authenticate Telegram user access;
2. use an independently authenticated ChatGPT Web browser profile;
3. create or register a remote conversation;
4. send a prompt exactly once under normal operation;
5. receive the correct completed response;
6. serialize same-conversation requests;
7. process different conversations independently;
8. restart without losing mappings or duplicating ambiguous requests;
9. pass the scenarios defined in `ACCEPTANCE.md`.

---

## 13. Product evolution after MVP

Possible later additions, intentionally not designed into MVP behavior:

- partial-response streaming;
- Web UI;
- REST API transport;
- Android client;
- multiple ChatGPT browser profiles/accounts;
- richer image/artifact retrieval;
- voice input;
- scheduled tasks;
- optional agent orchestration.

All future transports must reuse the same application core rather than driving the browser directly.
