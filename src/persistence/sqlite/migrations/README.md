# Forward migrations

R0 initializes only `schema_migrations`. Business tables belong to R1; this directory
intentionally contains no production SQL migration yet.

Add immutable SQL files named `NNNN_description.sql`, starting at `0001`, with unique
positive four-digit versions. Files are applied in numeric order. Applied files must
remain an unchanged prefix of this sequence; names and SHA-256 hashes are verified.

The runner applies pending SQL and ledger records in one `BEGIN IMMEDIATE` transaction.
SQL files must not contain transaction control, `VACUUM`, or connection pragmas.
An upgrade is forward-only: correct an applied migration with a new file, never by
editing or removing its predecessor. SQL fixtures under `tests/fixtures` are not
production migrations.
