# Forward migrations

R0 initialized only `schema_migrations`, with no applied production migrations.
R1 adds `0001_domain.sql`; an R0 database upgrades by applying this first business migration.

Add immutable SQL files named `NNNN_description.sql`, starting at `0001`, with unique
positive four-digit versions. Every next version must be exactly previous + 1;
gaps and duplicates are rejected before SQL. Applied files must
remain an unchanged prefix of this sequence; names and SHA-256 hashes are verified.

The runner applies pending SQL and ledger records in one `BEGIN IMMEDIATE` transaction.
SQL is preflighted as a whole before opening the migration transaction. A lexical
scanner handles strings, doubled quotes, quoted identifiers and SQLite comments;
only ordinary CREATE/ALTER/DROP/INSERT/UPDATE/DELETE/SELECT/WITH/REPLACE statements
are supported. Transaction control, `VACUUM`, all pragmas, ATTACH/DETACH and trigger
bodies are rejected. NUL and unclosed quotes/comments are rejected too. This is a
deliberately restricted migration language, not a general SQL security sandbox.
Keywords used as identifiers must be quoted. The scanner does not execute or prepare
SQL. Bun 1.4.0 exposes no public SQLite authorizer; EXPLAIN is unsuitable because
some pragmas take effect during preparation. Tests prove fresh/upgrade COMMIT rejection
without changes to schema, data, ledger or connection pragmas.
An upgrade is forward-only: correct an applied migration with a new file, never by
editing or removing its predecessor. SQL fixtures under `tests/fixtures` are not
production migrations.
