-- Operational output for bounded Telegram delivery; never a provider replay source.
CREATE TABLE request_deliveries (
  request_id TEXT PRIMARY KEY NOT NULL REFERENCES requests(id),
  state TEXT NOT NULL CHECK (state IN ('pending','delivered','failed','expired')),
  result_payload TEXT,
  plan TEXT,
  next_chunk INTEGER NOT NULL DEFAULT 0 CHECK (next_chunk >= 0),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 6),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  next_attempt_at TEXT,
  delivered_at TEXT,
  failure_code TEXT CHECK (failure_code IN ('TELEGRAM_DELIVERY_FAILED','TELEGRAM_DELIVERY_EXPIRED')),
  CHECK ((state IN ('pending','failed') AND result_payload IS NOT NULL)
    OR (state IN ('delivered','expired') AND result_payload IS NULL AND plan IS NULL)),
  CHECK ((state='pending') = (next_attempt_at IS NOT NULL)),
  CHECK ((state='delivered') = (delivered_at IS NOT NULL)),
  CHECK (state!='expired' OR failure_code='TELEGRAM_DELIVERY_EXPIRED')
) STRICT;
CREATE INDEX request_deliveries_due ON request_deliveries(state,next_attempt_at);
