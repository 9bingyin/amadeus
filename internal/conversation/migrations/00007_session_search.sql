-- +goose Up
CREATE TABLE message_search (
    id INTEGER PRIMARY KEY,
    message_record_id TEXT NOT NULL UNIQUE,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL,
    body TEXT NOT NULL
);

CREATE INDEX message_search_conversation ON message_search(conversation_id);

CREATE VIRTUAL TABLE message_fts USING fts5(
    body,
    content='message_search',
    content_rowid='id',
    tokenize='trigram case_sensitive 0'
);

-- +goose StatementBegin
CREATE TRIGGER message_search_ai AFTER INSERT ON message_search BEGIN
    INSERT INTO message_fts(rowid, body) VALUES (new.id, new.body);
END;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TRIGGER message_search_ad AFTER DELETE ON message_search BEGIN
    INSERT INTO message_fts(message_fts, rowid, body) VALUES ('delete', old.id, old.body);
END;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TRIGGER message_search_au AFTER UPDATE ON message_search BEGIN
    INSERT INTO message_fts(message_fts, rowid, body) VALUES ('delete', old.id, old.body);
    INSERT INTO message_fts(rowid, body) VALUES (new.id, new.body);
END;
-- +goose StatementEnd

-- +goose Down
DROP TRIGGER IF EXISTS message_search_au;
DROP TRIGGER IF EXISTS message_search_ad;
DROP TRIGGER IF EXISTS message_search_ai;
DROP TABLE IF EXISTS message_fts;
DROP INDEX IF EXISTS message_search_conversation;
DROP TABLE IF EXISTS message_search;
