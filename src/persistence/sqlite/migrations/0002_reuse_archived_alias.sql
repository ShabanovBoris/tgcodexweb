-- /remove releases the alias while archived mappings retain their ID, alias and request references.
-- SQLite's table UNIQUE cannot be dropped separately. Rebuild its foreign-key reference graph
-- in leaf-to-root order, then restore root-to-leaf, with foreign_keys still ON throughout.
-- The migration runner owns the transaction; no connection pragma or transaction control is needed.
CREATE TEMP TABLE r1_saved_conversations AS SELECT * FROM conversations;
CREATE TEMP TABLE r1_saved_active AS SELECT * FROM active_conversations;
CREATE TEMP TABLE r1_saved_requests AS SELECT * FROM requests;
CREATE TEMP TABLE r1_saved_updates AS SELECT * FROM processed_updates;
CREATE TEMP TABLE r1_saved_attachments AS SELECT * FROM attachments;

-- ❌ Удален UNIQUE для всех aliases: он резервировал невидимое архивное имя навсегда;
-- по решению пользователя имя снова доступно после /remove. Остальные constraints сохраняются.
DROP TABLE attachments;
DROP TABLE processed_updates;
DROP TABLE active_conversations;
DROP TABLE requests;
DROP TABLE conversations;

CREATE TABLE conversations (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  telegram_user_id TEXT NOT NULL REFERENCES users(telegram_user_id),
  alias TEXT NOT NULL CHECK (length(alias) > 0),
  provider_conversation_id TEXT NOT NULL CHECK (length(provider_conversation_id) > 0),
  provider_url TEXT,
  status TEXT NOT NULL CHECK (status IN ('ready', 'unavailable', 'unknown')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_used_at TEXT,
  archived INTEGER NOT NULL CHECK (archived IN (0, 1)),
  UNIQUE (telegram_user_id, id)
) STRICT;
CREATE INDEX conversations_provider_identity ON conversations(provider_conversation_id);

CREATE UNIQUE INDEX conversations_active_alias ON conversations(telegram_user_id, alias) WHERE archived = 0;

CREATE TABLE active_conversations (
  telegram_user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(telegram_user_id),
  conversation_id TEXT NOT NULL,
  FOREIGN KEY (telegram_user_id, conversation_id) REFERENCES conversations(telegram_user_id, id)
) STRICT;

CREATE TABLE requests (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  telegram_update_id TEXT NOT NULL UNIQUE CHECK (length(telegram_update_id) > 0),
  telegram_message_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('created', 'queued', 'uploading', 'sending', 'running', 'completed', 'failed', 'cancel_requested', 'cancelled', 'timeout', 'unknown')),
  provider_request_id TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  submitted_at TEXT,
  finished_at TEXT,
  failure_code TEXT,
  CHECK ((state IN ('completed', 'failed', 'cancelled', 'timeout', 'unknown')) = (finished_at IS NOT NULL)),
  CHECK (submitted_at IS NULL OR started_at IS NOT NULL),
  CHECK (provider_request_id IS NULL OR submitted_at IS NOT NULL),
  CHECK (state NOT IN ('created', 'queued') OR started_at IS NULL),
  CHECK (state NOT IN ('uploading', 'sending') OR submitted_at IS NULL),
  CHECK (state NOT IN ('uploading', 'sending', 'running', 'cancel_requested', 'completed', 'cancelled', 'timeout', 'unknown') OR started_at IS NOT NULL),
  CHECK (state NOT IN ('running', 'cancel_requested', 'completed', 'cancelled', 'timeout') OR submitted_at IS NOT NULL),
  CHECK ((state = 'failed') = (failure_code IS NOT NULL)),
  CHECK (failure_code IS NULL OR failure_code <> 'SEND_FAILED_PRE_SUBMIT' OR submitted_at IS NULL)
) STRICT;
CREATE INDEX requests_state ON requests(state);

CREATE TABLE processed_updates (
  telegram_update_id TEXT PRIMARY KEY NOT NULL CHECK (length(telegram_update_id) > 0),
  request_id TEXT REFERENCES requests(id),
  processed_at TEXT NOT NULL
) STRICT;

CREATE TABLE attachments (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  request_id TEXT NOT NULL REFERENCES requests(id),
  source_file_id TEXT NOT NULL CHECK (length(source_file_id) > 0),
  filename TEXT NOT NULL CHECK (length(filename) > 0),
  mime_type TEXT NOT NULL CHECK (length(mime_type) > 0),
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0 AND size_bytes <= 9007199254740991),
  temporary_storage_key TEXT,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX attachments_request ON attachments(request_id);

-- Explicit columns preserve each business value without rebinding historical requests to reused aliases.
INSERT INTO conversations (id, telegram_user_id, alias, provider_conversation_id, provider_url, status, created_at, updated_at, last_used_at, archived)
SELECT id, telegram_user_id, alias, provider_conversation_id, provider_url, status, created_at, updated_at, last_used_at, archived FROM r1_saved_conversations;
INSERT INTO requests (id, conversation_id, telegram_update_id, telegram_message_id, state, provider_request_id, created_at, started_at, submitted_at, finished_at, failure_code)
SELECT id, conversation_id, telegram_update_id, telegram_message_id, state, provider_request_id, created_at, started_at, submitted_at, finished_at, failure_code FROM r1_saved_requests;
INSERT INTO active_conversations (telegram_user_id, conversation_id)
SELECT telegram_user_id, conversation_id FROM r1_saved_active;
INSERT INTO processed_updates (telegram_update_id, request_id, processed_at)
SELECT telegram_update_id, request_id, processed_at FROM r1_saved_updates;
INSERT INTO attachments (id, request_id, source_file_id, filename, mime_type, size_bytes, temporary_storage_key, created_at)
SELECT id, request_id, source_file_id, filename, mime_type, size_bytes, temporary_storage_key, created_at FROM r1_saved_attachments;

DROP TABLE r1_saved_attachments;
DROP TABLE r1_saved_updates;
DROP TABLE r1_saved_requests;
DROP TABLE r1_saved_active;
DROP TABLE r1_saved_conversations;
