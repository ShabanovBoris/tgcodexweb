-- Operational input only: attachment values stay in attachments; this row preserves their accepted order.
-- AUTOINCREMENT preserves acceptance order across equal timestamps, restart and terminal input deletion.
CREATE TABLE request_inputs (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT CHECK (sequence <= 9007199254740991),
  request_id TEXT NOT NULL UNIQUE REFERENCES requests(id),
  payload TEXT NOT NULL
) STRICT;
