# ADR 0001 — R0 runtime and toolchain

Status: accepted by the approved R0 plan; implemented without changing its pins.
Evidence inspected: 2026-09-30. Scope: local repository bootstrap only.

## Upstream revision

Repository: `https://github.com/miuuyy/codex-chatgpt-web`.
Release: `v6.1.3`, published 2026-09-28.
Commit: `fa2d2c6c24926078b46eedb2186f69f2e8d548d7`.
The release tag and inspected default-branch head resolved to this same commit.
This revision is evidence for runtime requirements, not a gateway runtime dependency.

Immutable source evidence:

- [package.json](https://github.com/miuuyy/codex-chatgpt-web/blob/fa2d2c6c24926078b46eedb2186f69f2e8d548d7/package.json): `packageManager=bun@1.4.0`, `engines.bun=1.4.0`, TypeScript `5.9.3`, `@types/bun=1.4.0`, Zod `4.4.3`.
- [README](https://github.com/miuuyy/codex-chatgpt-web/blob/fa2d2c6c24926078b46eedb2186f69f2e8d548d7/README.md): the source path requires Bun `1.4.0`; packaged launchers bundle their browser/runtime.
- [CI](https://github.com/miuuyy/codex-chatgpt-web/blob/fa2d2c6c24926078b46eedb2186f69f2e8d548d7/.github/workflows/ci.yml): Bun `1.4.0` and frozen installs.
- [Runtime bundle builder](https://github.com/miuuyy/codex-chatgpt-web/blob/fa2d2c6c24926078b46eedb2186f69f2e8d548d7/scripts/build-runtime-bundle.ts): rejects a Bun version different from the exact manifest pin.
- [Server](https://github.com/miuuyy/codex-chatgpt-web/blob/fa2d2c6c24926078b46eedb2186f69f2e8d548d7/src/server.ts): uses `Bun.serve`; Node replacement is not established.

## Decision

Use Bun `1.4.0` for execution, package management, `bun:test` and `bun:sqlite`.
Pin TypeScript `5.9.3`, `@types/bun` `1.4.0`, Zod `4.4.3` and Biome `2.5.14`.
Use exact direct dependency versions and preserve transitive versions/integrities in
`bun.lock`. `package.json` is the runtime pin source; `toolchain:check` verifies Bun,
packageManager and matching Bun typings. Install with `--frozen-lockfile`.

Biome is a gateway tooling choice, not an upstream requirement.
[Its pinned release](https://github.com/biomejs/biome/releases/tag/%40biomejs/biome%402.5.14)
was checked during planning. One formatter/linter avoids a second configuration stack.
Recommended lint rules use this version's `preset: recommended` spelling.

Config is environment-only, validated with Zod and passed as data. Logger output is
allowlisted JSON metadata with central redaction. Automatic `.env` loading is disabled.
SQLite uses the built-in driver and immutable forward migrations with an atomic ledger.
Local `verify` satisfies the R0 CI-or-local-verification requirement without live services.

R0 initializes only the migration ledger. Business migrations, domain state, queues,
provider interfaces and transports remain in their later roadmap phases. `start` is a
one-shot bootstrap and cannot report `READY`.

## Limits and decision gates

- Bun pinning establishes documented runtime compatibility, not a complete provider contract.
- [Upstream architecture](https://github.com/miuuyy/codex-chatgpt-web/blob/fa2d2c6c24926078b46eedb2186f69f2e8d548d7/docs/architecture.md) binds browser chats to Codex tasks; saved chats do not establish arbitrary existing-conversation reopening. `/add` and AC-C04 remain unproven for R6.
- [Launcher manifest](https://github.com/miuuyy/codex-chatgpt-web/blob/fa2d2c6c24926078b46eedb2186f69f2e8d548d7/launcher/package.json) pins Electron `41.10.7`. A required exact system Node version for full launcher source development is not established. Node typings do not prove a runtime version. R0 does not build or install the launcher.
- Submission evidence, restart correlation, general attachments and cancellation must be inspected before provider implementation.
- [Bun SQLite documentation](https://bun.com/docs/runtime/sqlite) notes that macOS uses system SQLite; record `sqlite_version()` in verification rather than claiming an independent exact SQLite pin.
- [Upstream release validation](https://github.com/miuuyy/codex-chatgpt-web/blob/fa2d2c6c24926078b46eedb2186f69f2e8d548d7/docs/release-validation.md) separates build/CI evidence from account-bound ChatGPT acceptance.

There is no R0-D1 ambiguity for the selected Bun runtime. A contradictory requirement,
different revision or undocumented required runtime must trigger `R0-D1 DECISION_REQUEST`
before changing this decision. R0 does not resolve that future gate by assuming SDK or
conversation capabilities.
