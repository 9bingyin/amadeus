-- +goose Up
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    ordinal INTEGER NOT NULL CHECK (ordinal > 0),
    start_record_id TEXT NOT NULL UNIQUE REFERENCES records(id),
    end_record_id TEXT REFERENCES records(id),
    start_history_seq INTEGER NOT NULL CHECK (start_history_seq > 0),
    end_history_seq INTEGER,
    started_at_ms INTEGER NOT NULL,
    ended_at_ms INTEGER,
    UNIQUE (conversation_id, ordinal),
    CHECK (
        (end_record_id IS NULL AND end_history_seq IS NULL AND ended_at_ms IS NULL)
        OR (end_record_id IS NOT NULL AND end_history_seq IS NOT NULL AND ended_at_ms IS NOT NULL)
    ),
    CHECK (end_history_seq IS NULL OR end_history_seq >= start_history_seq - 1)
);

CREATE UNIQUE INDEX sessions_active_conversation
ON sessions(conversation_id)
WHERE end_record_id IS NULL;

ALTER TABLE conversations
ADD COLUMN active_session_id TEXT REFERENCES sessions(id);

ALTER TABLE runs
ADD COLUMN session_id TEXT REFERENCES sessions(id);

WITH raw_starts AS (
    SELECT
        c.id AS session_id,
        c.id AS conversation_id,
        r.id AS start_record_id,
        r.seq AS start_record_seq,
        1 AS start_history_seq,
        r.created_at_ms AS started_at_ms
    FROM conversations c
    JOIN records r
      ON r.conversation_id = c.id
     AND r.kind = 'conversation.created'
    UNION ALL
    SELECT
        r.id AS session_id,
        r.conversation_id,
        r.id AS start_record_id,
        r.seq AS start_record_seq,
        CAST(json_extract(r.payload_json, '$.sourceHistoryThroughSeq') AS INTEGER) + 1 AS start_history_seq,
        r.created_at_ms AS started_at_ms
    FROM records r
    WHERE r.kind = 'context.checkpoint.created'
      AND json_extract(r.payload_json, '$.cause') = 'new'
      AND NOT (
          CAST(json_extract(r.payload_json, '$.sourceHistoryThroughSeq') AS INTEGER) = 0
          AND EXISTS (
              SELECT 1
              FROM records created
              WHERE created.conversation_id = r.conversation_id
                AND created.kind = 'conversation.created'
                AND created.commit_id = r.commit_id
          )
      )
),
ordered_starts AS (
    SELECT
        session_id,
        conversation_id,
        start_record_id,
        start_record_seq,
        start_history_seq,
        started_at_ms,
        ROW_NUMBER() OVER (
            PARTITION BY conversation_id ORDER BY start_record_seq
        ) AS ordinal,
        LEAD(start_record_id) OVER (
            PARTITION BY conversation_id ORDER BY start_record_seq
        ) AS end_record_id,
        LEAD(start_history_seq) OVER (
            PARTITION BY conversation_id ORDER BY start_record_seq
        ) - 1 AS end_history_seq,
        LEAD(started_at_ms) OVER (
            PARTITION BY conversation_id ORDER BY start_record_seq
        ) AS ended_at_ms
    FROM raw_starts
)
INSERT INTO sessions (
    id, conversation_id, ordinal, start_record_id, end_record_id,
    start_history_seq, end_history_seq, started_at_ms, ended_at_ms
)
SELECT
    session_id, conversation_id, ordinal, start_record_id, end_record_id,
    start_history_seq, end_history_seq, started_at_ms, ended_at_ms
FROM ordered_starts;

UPDATE conversations
SET active_session_id = (
    SELECT s.id
    FROM sessions s
    WHERE s.conversation_id = conversations.id
      AND s.end_record_id IS NULL
);

UPDATE runs
SET session_id = (
    SELECT s.id
    FROM sessions s
    JOIN records started ON started.id = s.start_record_id
    WHERE s.conversation_id = runs.conversation_id
      AND started.seq <= runs.queue_seq
    ORDER BY started.seq DESC
    LIMIT 1
);

CREATE INDEX runs_session_queue ON runs(session_id, queue_seq);

-- +goose Down
DROP INDEX runs_session_queue;
ALTER TABLE runs DROP COLUMN session_id;
ALTER TABLE conversations DROP COLUMN active_session_id;
DROP INDEX sessions_active_conversation;
DROP TABLE sessions;
