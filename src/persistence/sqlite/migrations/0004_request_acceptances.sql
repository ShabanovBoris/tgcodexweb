-- Retention ownership survives payload loss/deletion without storing text or working attachment references.
CREATE TABLE request_acceptances (
  request_id TEXT PRIMARY KEY NOT NULL REFERENCES requests(id)
) STRICT;

-- Existing R2 inputs prove ownership; legacy metadata without that evidence must not be reclassified.
INSERT INTO request_acceptances (request_id) SELECT request_id FROM request_inputs;
