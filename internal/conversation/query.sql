-- name: InsertRecord :one
INSERT INTO records (
    id, commit_id, conversation_id, run_id, kind, schema_version,
    source_namespace, source_event_id, payload_json, payload_sha256, created_at_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
RETURNING seq;

-- name: GetRecord :one
SELECT * FROM records WHERE id = ?;

-- name: GetIngressRecord :one
SELECT * FROM records
WHERE kind = 'ingress.received' AND source_namespace = ? AND source_event_id = ?;

-- name: GetContextCommandRecord :one
SELECT * FROM records
WHERE kind = 'conversation.command.completed' AND source_namespace = ? AND source_event_id = ?;

-- name: UpsertConversation :one
INSERT INTO conversations (
    id, platform, account_id, external_chat_id, external_thread_id,
    next_history_seq, created_at_ms, updated_at_ms
) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
ON CONFLICT (platform, account_id, external_chat_id, external_thread_id)
DO UPDATE SET updated_at_ms = excluded.updated_at_ms
RETURNING *;

-- name: GetConversation :one
SELECT * FROM conversations WHERE id = ?;

-- name: GetConversationByRoute :one
SELECT * FROM conversations
WHERE platform = ? AND account_id = ? AND external_chat_id = ? AND external_thread_id = ?;

-- name: SetActiveSession :execrows
UPDATE conversations
SET active_session_id = sqlc.arg(session_id), updated_at_ms = sqlc.arg(updated_at_ms)
WHERE id = sqlc.arg(conversation_id)
  AND COALESCE(active_session_id, '') = sqlc.arg(previous_session_id);

-- name: InsertSession :exec
INSERT INTO sessions (
    id, conversation_id, ordinal, start_record_id, start_history_seq, started_at_ms
) VALUES (?, ?, ?, ?, ?, ?);

-- name: GetSession :one
SELECT * FROM sessions WHERE id = ?;

-- name: GetActiveSession :one
SELECT s.*
FROM sessions s
JOIN conversations c ON c.active_session_id = s.id
WHERE c.id = ?;

-- name: CloseSession :execrows
UPDATE sessions
SET end_record_id = ?, end_history_seq = ?, ended_at_ms = ?
WHERE id = ? AND conversation_id = ? AND end_record_id IS NULL;

-- name: ReserveHistoryRange :one
UPDATE conversations
SET next_history_seq = next_history_seq + sqlc.arg(count), updated_at_ms = sqlc.arg(updated_at_ms)
WHERE id = sqlc.arg(conversation_id)
RETURNING next_history_seq - sqlc.arg(count) AS first_history_seq;

-- name: SetActiveContextCheckpoint :execrows
UPDATE conversations
SET active_context_checkpoint_record_id = sqlc.arg(record_id),
    updated_at_ms = sqlc.arg(updated_at_ms)
WHERE id = sqlc.arg(conversation_id)
  AND next_history_seq - 1 = sqlc.arg(history_through_seq)
  AND COALESCE(active_context_checkpoint_record_id, '') = sqlc.arg(parent_record_id);

-- name: InsertRun :exec
INSERT INTO runs (
    id, conversation_id, session_id, queue_seq, status, provider, model, reasoning_effort,
    system_prompt, config_json, next_step_seq, created_at_ms,
    input_not_before_ms, input_revision, handled_input_revision
) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, 0, ?, ?, 0, 0);

-- name: GetRun :one
SELECT * FROM runs WHERE id = ?;

-- name: GetOpenRun :one
SELECT * FROM runs
WHERE conversation_id = ? AND status IN ('queued', 'running')
LIMIT 1;

-- name: GetRunningRun :one
SELECT * FROM runs WHERE status = 'running' LIMIT 1;

-- name: GetNextQueuedRun :one
SELECT * FROM runs WHERE status = 'queued' ORDER BY queue_seq LIMIT 1;

-- name: AdvanceRunInput :one
UPDATE runs
SET input_not_before_ms = CASE
        WHEN status = 'running' AND input_revision = handled_input_revision
            THEN sqlc.arg(input_not_before_ms)
        ELSE input_not_before_ms
    END,
    input_revision = input_revision + 1
WHERE id = sqlc.arg(id) AND status IN ('queued', 'running')
RETURNING *;

-- name: StartRun :execrows
UPDATE runs
SET status = 'running', started_at_ms = ?,
    handled_input_revision = input_revision, input_not_before_ms = NULL
WHERE id = ? AND status = 'queued';

-- name: AcknowledgeRunInput :execrows
UPDATE runs
SET handled_input_revision = input_revision, input_not_before_ms = NULL
WHERE id = ? AND status = 'running' AND input_not_before_ms <= ?;

-- name: SetRunTerminal :execrows
UPDATE runs
SET status = ?, error_code = ?, error_message = ?, finished_at_ms = ?
WHERE id = ? AND status = 'running';

-- name: AdvanceRunStep :one
UPDATE runs SET next_step_seq = next_step_seq + 1
WHERE id = ? AND status = 'running'
RETURNING next_step_seq - 1 AS step_seq;

-- name: InterruptRunningRuns :many
UPDATE runs
SET status = 'interrupted', error_code = 'process_restart',
    error_message = 'agent process stopped before the run completed', finished_at_ms = ?
WHERE status = 'running'
RETURNING *;

-- name: InsertMessage :exec
INSERT INTO messages (
    record_id, conversation_id, run_id, source_record_id, role,
    history_seq, step_seq, step_message_seq, committed_at_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);

-- name: GetMessage :one
SELECT * FROM messages WHERE record_id = ?;

-- name: GetMessageBySourceRecord :one
SELECT * FROM messages WHERE source_record_id = ?;

-- name: ListRecords :many
SELECT * FROM records ORDER BY seq;

-- name: ListConversationHistory :many
SELECT r.payload_json, r.schema_version, m.*
FROM messages m
JOIN records r ON r.id = m.record_id
WHERE m.conversation_id = ? AND m.history_seq IS NOT NULL
ORDER BY m.history_seq;

-- name: ListConversationHistoryAfter :many
SELECT r.payload_json, r.schema_version, m.*
FROM messages m
JOIN records r ON r.id = m.record_id
WHERE m.conversation_id = ? AND m.history_seq > ?
ORDER BY m.history_seq;

-- name: GetSessionUsageStart :one
SELECT CAST(COALESCE((
    SELECT CAST(json_extract(r.payload_json, '$.sourceHistoryThroughSeq') AS INTEGER)
    FROM records r
    WHERE r.conversation_id = s.conversation_id
      AND r.kind = 'context.checkpoint.created'
      AND json_extract(r.payload_json, '$.sessionId') = s.id
    ORDER BY r.seq DESC
    LIMIT 1
), s.start_history_seq - 1) AS INTEGER) AS after_history_seq
FROM sessions s
WHERE s.id = sqlc.arg(session_id) AND s.conversation_id = sqlc.arg(conversation_id);

-- name: ListSessionAssistantPayloads :many
SELECT r.payload_json, r.schema_version
FROM messages m
JOIN records r ON r.id = m.record_id
JOIN sessions s ON s.id = sqlc.arg(session_id)
WHERE m.conversation_id = sqlc.arg(conversation_id)
  AND s.conversation_id = m.conversation_id
  AND m.role = 'assistant'
  AND m.history_seq IS NOT NULL
  AND m.history_seq > CAST(sqlc.arg(after_history_seq) AS INTEGER)
  AND m.history_seq >= s.start_history_seq
  AND (s.end_history_seq IS NULL OR m.history_seq <= s.end_history_seq);

-- name: ListPendingRunMessages :many
SELECT r.payload_json, r.schema_version, m.*
FROM messages m
JOIN records r ON r.id = m.record_id
WHERE m.run_id = ? AND m.history_seq IS NULL
ORDER BY r.seq;

-- name: GetLatestRunUserMessage :one
SELECT m.*
FROM messages m
JOIN records r ON r.id = m.record_id
WHERE m.run_id = ? AND m.role = 'user'
ORDER BY r.seq DESC
LIMIT 1;

-- name: GetLatestRunAssistantPayload :one
SELECT r.payload_json
FROM messages m
JOIN records r ON r.id = m.record_id
WHERE m.run_id = ? AND m.role = 'assistant' AND m.history_seq IS NOT NULL
ORDER BY m.history_seq DESC
LIMIT 1;

-- name: CommitMessageToHistory :execrows
UPDATE messages
SET history_seq = ?, committed_at_ms = ?
WHERE record_id = ? AND history_seq IS NULL;

-- name: InsertOutbox :exec
INSERT INTO outbox (
    id, record_id, enqueue_seq, conversation_id, run_id, message_record_id, reply_to_record_id,
    kind, chunk_index, chunk_count, status, attempts, available_at_ms, created_at_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?);

-- name: GetOutbox :one
SELECT o.*, r.payload_json, r.schema_version
FROM outbox o
JOIN records r ON r.id = o.record_id
WHERE o.id = ?;

-- name: ListPendingOutboxHeads :many
SELECT o.*, r.payload_json, r.schema_version
FROM outbox o
JOIN records r ON r.id = o.record_id
WHERE o.status = 'pending'
  AND o.available_at_ms <= ?
  AND o.id = (
      SELECT o2.id FROM outbox o2
      WHERE o2.conversation_id = o.conversation_id
        AND o2.status NOT IN ('sent', 'dead')
      ORDER BY o2.enqueue_seq
      LIMIT 1
  )
ORDER BY o.enqueue_seq;

-- name: MarkOutboxAttempt :execrows
UPDATE outbox SET attempts = attempts + 1, last_error = NULL WHERE id = ? AND status = 'pending';

-- name: MarkOutboxSent :execrows
UPDATE outbox SET status = 'sent', sent_at_ms = ?, last_error = NULL WHERE id = ? AND status = 'pending';

-- name: RescheduleOutbox :execrows
UPDATE outbox SET available_at_ms = ?, last_error = ? WHERE id = ? AND status = 'pending';

-- name: MarkOutboxDead :execrows
UPDATE outbox SET status = 'dead', last_error = ? WHERE id = ? AND status = 'pending';

-- name: ListConversationUserActivity :many
SELECT id, platform, account_id, external_chat_id, external_thread_id, last_user_at_ms, busy
FROM (
  SELECT
    c.id,
    c.platform,
    c.account_id,
    c.external_chat_id,
    c.external_thread_id,
    (
      SELECT MAX(ingress.created_at_ms)
      FROM messages m
      JOIN records ingress ON ingress.id = m.source_record_id
        AND ingress.kind = 'ingress.received'
      WHERE m.conversation_id = c.id
        AND m.role = 'user'
        AND m.history_seq IS NOT NULL
        AND ingress.source_namespace <> ?
    ) AS last_user_at_ms,
    EXISTS (
      SELECT 1 FROM runs r
      WHERE r.conversation_id = c.id
        AND r.status IN ('queued', 'running')
    ) AS busy
  FROM conversations c
) activity
WHERE last_user_at_ms IS NOT NULL;
