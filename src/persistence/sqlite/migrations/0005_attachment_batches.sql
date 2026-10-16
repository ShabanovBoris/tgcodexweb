-- A Telegram album has no end marker. Explicit /send atomically accepts one durable draft.
CREATE TABLE attachment_batches (
  id TEXT PRIMARY KEY NOT NULL,
  telegram_user_id TEXT NOT NULL,
  telegram_chat_id TEXT NOT NULL,
  media_group_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open','closed')),
  UNIQUE (telegram_user_id, telegram_chat_id, media_group_id),
  FOREIGN KEY (telegram_user_id, conversation_id) REFERENCES conversations(telegram_user_id, id)
) STRICT;
CREATE UNIQUE INDEX attachment_batches_one_open ON attachment_batches(telegram_user_id) WHERE state='open';
CREATE TABLE attachment_batch_items (
  id TEXT PRIMARY KEY NOT NULL,
  batch_id TEXT NOT NULL REFERENCES attachment_batches(id),
  telegram_update_id TEXT NOT NULL UNIQUE REFERENCES processed_updates(telegram_update_id),
  telegram_message_id INTEGER NOT NULL CHECK (telegram_message_id > 0),
  caption TEXT,
  source_file_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0 AND size_bytes <= 9007199254740991),
  temporary_storage_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  UNIQUE (batch_id, telegram_message_id)
) STRICT;
