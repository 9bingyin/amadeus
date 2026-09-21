-- +goose Up
ALTER TABLE conversations
ADD COLUMN active_context_checkpoint_record_id TEXT REFERENCES records(id);

-- +goose Down
ALTER TABLE conversations DROP COLUMN active_context_checkpoint_record_id;
