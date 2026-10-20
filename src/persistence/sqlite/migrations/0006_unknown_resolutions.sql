-- An operator assertion releases capacity without rewriting UNKNOWN or enabling replay.
CREATE TABLE request_unknown_resolutions (
  request_id TEXT PRIMARY KEY NOT NULL REFERENCES requests(id),
  provider_conversation_id TEXT NOT NULL CHECK (length(provider_conversation_id) > 0),
  confirmed_at TEXT NOT NULL CHECK (length(confirmed_at) > 0),
  resolution TEXT NOT NULL CHECK (resolution = 'operator_confirmed_completed')
) STRICT;
