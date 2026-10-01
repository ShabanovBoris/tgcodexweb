-- Local mappings and lifecycle metadata only; no prompt/response history or browser credentials.
CREATE TABLE users (
  telegram_user_id TEXT PRIMARY KEY NOT NULL CHECK (length(telegram_user_id) > 0),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL
) STRICT;

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
  UNIQUE (telegram_user_id, alias),
  UNIQUE (telegram_user_id, id)
) STRICT;
CREATE INDEX conversations_provider_identity ON conversations(provider_conversation_id);

-- Composite FK prevents selecting another user's mapping; archive clears this row transactionally.
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

-- ❌ Удален составной FK по update_id/request_id: один Request может быть связан с несколькими ingress updates;
-- invariant запрещает второй Request на update, но не дополнительные markers на тот же Request.

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
