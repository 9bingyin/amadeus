-- +goose Up
ALTER TABLE runs ADD COLUMN input_not_before_ms INTEGER;
ALTER TABLE runs ADD COLUMN input_revision INTEGER NOT NULL DEFAULT 0 CHECK (input_revision >= 0);
ALTER TABLE runs ADD COLUMN handled_input_revision INTEGER NOT NULL DEFAULT 0 CHECK (handled_input_revision >= 0 AND handled_input_revision <= input_revision);

UPDATE runs
SET input_revision = (
    SELECT COUNT(*)
    FROM messages
    WHERE messages.run_id = runs.id AND messages.role = 'user'
);

UPDATE runs
SET handled_input_revision = (
    SELECT COUNT(*)
    FROM messages
    WHERE messages.run_id = runs.id
      AND messages.role = 'user'
      AND messages.history_seq IS NOT NULL
);

UPDATE runs
SET input_not_before_ms = created_at_ms
WHERE status = 'queued';

CREATE INDEX runs_queued_deadline
ON runs(queue_seq, input_not_before_ms)
WHERE status = 'queued';

-- +goose Down
DROP INDEX runs_queued_deadline;
ALTER TABLE runs DROP COLUMN handled_input_revision;
ALTER TABLE runs DROP COLUMN input_revision;
ALTER TABLE runs DROP COLUMN input_not_before_ms;
