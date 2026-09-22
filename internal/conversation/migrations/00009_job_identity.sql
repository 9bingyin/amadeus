-- +goose Up
ALTER TABLE jobs ADD COLUMN identity TEXT NOT NULL DEFAULT '';
UPDATE jobs SET identity = 'Schedule #' || id || ' ' || name WHERE identity = '';

-- +goose Down
ALTER TABLE jobs DROP COLUMN identity;
