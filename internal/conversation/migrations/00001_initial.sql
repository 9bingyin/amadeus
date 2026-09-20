-- +goose Up
CREATE TABLE records (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    commit_id TEXT NOT NULL,
    conversation_id TEXT,
    run_id TEXT,
    kind TEXT NOT NULL,
    schema_version INTEGER NOT NULL CHECK (schema_version > 0),
    source_namespace TEXT,
    source_event_id TEXT,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    payload_sha256 BLOB NOT NULL CHECK (typeof(payload_sha256) = 'blob' AND length(payload_sha256) = 32),
    created_at_ms INTEGER NOT NULL,
    CHECK (
        kind <> 'ingress.received'
        OR (source_namespace IS NOT NULL AND source_namespace <> '' AND source_event_id IS NOT NULL AND source_event_id <> '')
    )
);

CREATE UNIQUE INDEX records_ingress_source
ON records(source_namespace, source_event_id)
WHERE kind = 'ingress.received';

CREATE INDEX records_conversation_seq ON records(conversation_id, seq);
CREATE INDEX records_run_seq ON records(run_id, seq) WHERE run_id IS NOT NULL;
CREATE INDEX records_commit_id ON records(commit_id);

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

CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL,
    account_id TEXT NOT NULL,
    external_chat_id TEXT NOT NULL,
    external_thread_id TEXT NOT NULL DEFAULT '',
    next_history_seq INTEGER NOT NULL DEFAULT 1 CHECK (next_history_seq > 0),
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    UNIQUE (platform, account_id, external_chat_id, external_thread_id)
);

CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    queue_seq INTEGER NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'canceled', 'interrupted')),
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    reasoning_effort TEXT,
    system_prompt TEXT NOT NULL,
    config_json TEXT CHECK (config_json IS NULL OR json_valid(config_json)),
    next_step_seq INTEGER NOT NULL DEFAULT 0 CHECK (next_step_seq >= 0),
    error_code TEXT,
    error_message TEXT,
    created_at_ms INTEGER NOT NULL,
    started_at_ms INTEGER,
    finished_at_ms INTEGER,
    UNIQUE (id, conversation_id)
);

CREATE UNIQUE INDEX runs_open_conversation
ON runs(conversation_id)
WHERE status IN ('queued', 'running');

CREATE UNIQUE INDEX runs_single_running
ON runs(status)
WHERE status = 'running';

CREATE INDEX runs_queued_fifo ON runs(queue_seq) WHERE status = 'queued';

CREATE TABLE messages (
    record_id TEXT PRIMARY KEY REFERENCES records(id),
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    run_id TEXT NOT NULL,
    source_record_id TEXT REFERENCES records(id),
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'system', 'developer')),
    history_seq INTEGER,
    step_seq INTEGER,
    step_message_seq INTEGER,
    committed_at_ms INTEGER,
    FOREIGN KEY (run_id, conversation_id) REFERENCES runs(id, conversation_id),
    CHECK ((history_seq IS NULL AND committed_at_ms IS NULL) OR (history_seq IS NOT NULL AND committed_at_ms IS NOT NULL)),
    CHECK (history_seq IS NOT NULL OR role = 'user'),
    CHECK (
        (role = 'user' AND step_seq IS NULL AND step_message_seq IS NULL)
        OR (role <> 'user' AND step_seq IS NOT NULL AND step_message_seq IS NOT NULL)
    )
);

CREATE UNIQUE INDEX messages_history_seq
ON messages(conversation_id, history_seq)
WHERE history_seq IS NOT NULL;

CREATE UNIQUE INDEX messages_step_position
ON messages(run_id, step_seq, step_message_seq)
WHERE step_seq IS NOT NULL;

CREATE UNIQUE INDEX messages_source_record
ON messages(source_record_id)
WHERE source_record_id IS NOT NULL;

CREATE INDEX messages_pending_run
ON messages(run_id, record_id)
WHERE history_seq IS NULL;

CREATE TABLE outbox (
    id TEXT PRIMARY KEY,
    record_id TEXT NOT NULL UNIQUE REFERENCES records(id),
    enqueue_seq INTEGER NOT NULL UNIQUE,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    run_id TEXT NOT NULL,
    message_record_id TEXT REFERENCES messages(record_id),
    reply_to_record_id TEXT REFERENCES messages(record_id),
    kind TEXT NOT NULL CHECK (kind IN ('final', 'error')),
    chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
    chunk_count INTEGER NOT NULL CHECK (chunk_count > 0 AND chunk_index < chunk_count),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'dead')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    available_at_ms INTEGER NOT NULL,
    last_error TEXT,
    created_at_ms INTEGER NOT NULL,
    sent_at_ms INTEGER,
    FOREIGN KEY (run_id, conversation_id) REFERENCES runs(id, conversation_id),
    UNIQUE (run_id, chunk_index),
    CHECK ((kind = 'final' AND message_record_id IS NOT NULL) OR kind = 'error')
);

CREATE INDEX outbox_pending_fifo
ON outbox(conversation_id, enqueue_seq)
WHERE status = 'pending';

-- +goose StatementBegin
CREATE TRIGGER records_no_update
BEFORE UPDATE ON records
BEGIN
    SELECT RAISE(ABORT, 'records are immutable');
END;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TRIGGER records_no_delete
BEFORE DELETE ON records
BEGIN
    SELECT RAISE(ABORT, 'records are immutable');
END;
-- +goose StatementEnd

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

-- +goose Down
DROP TRIGGER blobs_no_delete;
DROP TRIGGER blobs_no_update;
DROP TRIGGER records_no_delete;
DROP TRIGGER records_no_update;
DROP TABLE outbox;
DROP TABLE messages;
DROP TABLE runs;
DROP TABLE conversations;
DROP TABLE record_blobs;
DROP TABLE blobs;
DROP TABLE records;
