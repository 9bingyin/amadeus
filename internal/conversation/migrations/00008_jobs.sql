-- +goose Up
CREATE TABLE jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('once', 'every', 'cron')),
    spec TEXT NOT NULL,
    next_run_at_ms INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('scheduled', 'running', 'completed')),
    last_status TEXT NOT NULL DEFAULT '' CHECK (last_status IN ('', 'ok', 'silent', 'error')),
    last_error TEXT NOT NULL DEFAULT '',
    platform TEXT NOT NULL,
    account_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    thread_id TEXT NOT NULL DEFAULT '',
    created_at_ms INTEGER NOT NULL
);

CREATE INDEX jobs_due ON jobs(next_run_at_ms) WHERE state = 'scheduled';
CREATE INDEX jobs_route ON jobs(platform, account_id, chat_id, thread_id);

-- +goose Down
DROP INDEX jobs_route;
DROP INDEX jobs_due;
DROP TABLE jobs;
