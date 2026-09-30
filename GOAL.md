# GOAL.md

## Copy-paste `/goal` prompt

```text
/goal

Build the standalone TG WebGPT Gateway defined by this repository.

Before modifying anything, read in this order:
1. PRODUCT.md
2. ARCHITECTURE.md
3. ACCEPTANCE.md
4. ROADMAP.md
5. AGENTS.md
6. the current source/tests/status of the repository

Your objective is not to scaffold a demo. Your objective is a stable MVP that passes the mandatory acceptance criteria.

Execution rules:
- Follow ROADMAP.md in order. Start from the earliest incomplete phase.
- Keep the project fully standalone. Do not read from, depend on, reuse runtime state from, or modify NightReviewer or other unrelated projects.
- Do not use OpenAI API for normal model generation. The product must route through the configured ChatGPT Web provider adapter.
- Telegram is only a transport. It must not control browser automation directly.
- Keep all codex-chatgpt-web/browser-specific behavior behind the ChatProvider boundary.
- Preserve the architectural invariants in ARCHITECTURE.md.
- Treat idempotency, same-conversation serialization and crash-safe non-replay as correctness requirements, not optimizations.
- Never blindly retry a request if provider submission may already have happened.
- Never expose or commit Telegram tokens, ChatGPT cookies/session tokens, browser auth storage or authorization headers.
- Do not add post-MVP features unless they are required to satisfy an acceptance criterion.
- Use fakes for deterministic core tests. Live ChatGPT integration tests must be explicitly opt-in.
- Pin exact repository tooling/runtime only after inspecting the selected codex-chatgpt-web upstream requirements. If the required version is materially ambiguous, stop and issue a DECISION_REQUEST instead of guessing.

For every implementation step:
1. inspect existing code and tests;
2. identify the exact roadmap item, acceptance criteria and invariants affected;
3. make the smallest complete change;
4. add/update tests;
5. run focused verification;
6. run relevant broader verification;
7. inspect the diff for scope creep and secret leakage;
8. update docs only when the behavior or architecture actually changed.

Do not ask routine implementation questions that can be answered from the repository. Make reversible local choices yourself. Ask only when a missing decision changes product scope, security, provider semantics, recovery behavior, canonical identity, destructive behavior, or upstream/runtime compatibility.

If blocked by such a decision, return exactly:

DECISION_REQUEST
Question: ...
Why required now: ...
Evidence: ...
Options:
1. ...
2. ...
Consequences: ...
Blocked work: ...

Otherwise continue implementation until the current roadmap phase is complete and verified.

At the end of each completed phase, report:
- Phase
- Result
- Files changed
- Acceptance criteria/invariants covered
- Tests run and results
- Remaining blockers/decisions
- Next roadmap phase

Do not claim MVP complete until every mandatory criterion in ACCEPTANCE.md has reproducible passing evidence.
```

---

## Short `/goal` variant for agents that already received repository context

```text
/goal
Read PRODUCT.md, ARCHITECTURE.md, ACCEPTANCE.md, ROADMAP.md and AGENTS.md. Continue from the earliest incomplete roadmap phase. Implement the smallest complete standalone change, preserve all invariants, test it, and continue phase-by-phase. Do not depend on NightReviewer, do not use OpenAI API for generation, do not leak auth secrets, and never auto-replay an ambiguous provider submission. Ask only for a decision that materially changes scope/security/provider/recovery/runtime compatibility. Do not claim MVP complete until ACCEPTANCE.md has passing evidence.
```
