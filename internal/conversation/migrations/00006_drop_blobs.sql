-- +goose Up
DROP TRIGGER IF EXISTS blobs_no_delete;
DROP TRIGGER IF EXISTS blobs_no_update;
DROP TABLE IF EXISTS record_blobs;
DROP TABLE IF EXISTS blobs;

-- +goose Down
CREATE TABLE blobs (
    sha256 BLOB PRIMARY KEY CHECK (typeof(sha256) = 'blob' AND length(sha256) = 32),
    data BLOB NOT NULL,
    created_at_ms INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE record_blobs (
    record_id TEXT NOT NULL REFERENCES records(id),
    part_index INTEGER NOT NULL CHECK (part_index >= 0),
    sha256 BLOB NOT NULL REFERENCES blobs(sha256),
    PRIMARY KEY (record_id, part_index)
) WITHOUT ROWID;

CREATE INDEX record_blobs_sha256 ON record_blobs(sha256);

-- +goose StatementBegin
CREATE TRIGGER blobs_no_update
BEFORE UPDATE ON blobs
BEGIN
    SELECT RAISE(ABORT, 'blobs are immutable');
END;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TRIGGER blobs_no_delete
BEFORE DELETE ON blobs
BEGIN
    SELECT RAISE(ABORT, 'blobs are immutable');
END;
-- +goose StatementEnd
