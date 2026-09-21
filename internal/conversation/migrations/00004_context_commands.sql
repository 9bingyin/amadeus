-- +goose Up
CREATE UNIQUE INDEX records_context_command_source_unique
ON records(source_namespace, source_event_id)
WHERE kind = 'conversation.command.completed';

ALTER TABLE outbox RENAME TO outbox_before_context_commands;

CREATE TABLE outbox (
    id TEXT PRIMARY KEY,
    record_id TEXT NOT NULL UNIQUE REFERENCES records(id),
    enqueue_seq INTEGER NOT NULL UNIQUE,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    run_id TEXT,
    message_record_id TEXT REFERENCES messages(record_id),
    reply_to_record_id TEXT REFERENCES messages(record_id),
    kind TEXT NOT NULL CHECK (kind IN ('final', 'error', 'command')),
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
    CHECK (
        (kind = 'final' AND run_id IS NOT NULL AND message_record_id IS NOT NULL)
        OR (kind = 'error' AND run_id IS NOT NULL)
        OR (kind = 'command' AND run_id IS NULL AND message_record_id IS NULL)
    )
);

INSERT INTO outbox (
    id, record_id, enqueue_seq, conversation_id, run_id, message_record_id,
    reply_to_record_id, kind, chunk_index, chunk_count, status, attempts,
    available_at_ms, last_error, created_at_ms, sent_at_ms
)
SELECT
    id, record_id, enqueue_seq, conversation_id, run_id, message_record_id,
    reply_to_record_id, kind, chunk_index, chunk_count, status, attempts,
    available_at_ms, last_error, created_at_ms, sent_at_ms
FROM outbox_before_context_commands;

DROP TABLE outbox_before_context_commands;

CREATE INDEX outbox_pending_fifo
ON outbox(conversation_id, enqueue_seq)
WHERE status = 'pending';

-- +goose Down
ALTER TABLE outbox RENAME TO outbox_with_context_commands;

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

INSERT INTO outbox (
    id, record_id, enqueue_seq, conversation_id, run_id, message_record_id,
    reply_to_record_id, kind, chunk_index, chunk_count, status, attempts,
    available_at_ms, last_error, created_at_ms, sent_at_ms
)
SELECT
    id, record_id, enqueue_seq, conversation_id, run_id, message_record_id,
    reply_to_record_id, kind, chunk_index, chunk_count, status, attempts,
    available_at_ms, last_error, created_at_ms, sent_at_ms
FROM outbox_with_context_commands
WHERE kind IN ('final', 'error');

DROP TABLE outbox_with_context_commands;

CREATE INDEX outbox_pending_fifo
ON outbox(conversation_id, enqueue_seq)
WHERE status = 'pending';

DROP INDEX records_context_command_source_unique;
