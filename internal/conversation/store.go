package conversation

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/9bingyin/amadeus/internal/conversation/db"
	"github.com/pressly/goose/v3"
	_ "modernc.org/sqlite"
)

type Route struct {
	Platform  string
	AccountID string
	ChatID    string
	ThreadID  string
}

type RunSpec struct {
	Provider        string
	Model           string
	ReasoningEffort string
	SystemPrompt    string
	Config          json.RawMessage
	InputWindow     time.Duration
}

type AcceptedMessage struct {
	ConversationID     string
	RunID              string
	RunStatus          string
	IngressRecordID    string
	MessageRecordID    string
	InputRevision      int64
	InterruptRequested bool
	Duplicate          bool
}

type AcceptInput struct {
	Route           Route
	SourceNamespace string
	SourceEventID   string
	IngressPayload  json.RawMessage
	Message         EncodedMessage
	Run             RunSpec
}

type Store struct {
	database *sql.DB
	now      func() time.Time
	newID    func() (string, error)
}

func Open(ctx context.Context, path string) (*Store, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil, errors.New("state database path is required")
	}
	if !filepath.IsAbs(path) {
		return nil, fmt.Errorf("state database path %q is not absolute", path)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("create state database directory: %w", err)
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("create state database: %w", err)
	}
	if err := file.Close(); err != nil {
		return nil, fmt.Errorf("close state database file: %w", err)
	}
	if err := os.Chmod(path, 0o600); err != nil {
		return nil, fmt.Errorf("secure state database: %w", err)
	}

	query := url.Values{
		"_txlock": {"immediate"},
		"_pragma": {
			"busy_timeout(5000)",
			"foreign_keys(1)",
			"journal_mode(WAL)",
			"synchronous(FULL)",
		},
	}
	dsn := (&url.URL{Scheme: "file", Path: path, RawQuery: query.Encode()}).String()
	database, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open state database: %w", err)
	}
	database.SetMaxOpenConns(1)
	database.SetMaxIdleConns(1)
	if err := database.PingContext(ctx); err != nil {
		_ = database.Close()
		return nil, fmt.Errorf("connect state database: %w", err)
	}

	migrationFS, err := fs.Sub(migrationFiles, "migrations")
	if err != nil {
		_ = database.Close()
		return nil, fmt.Errorf("open state migrations: %w", err)
	}
	provider, err := goose.NewProvider(goose.DialectSQLite3, database, migrationFS)
	if err != nil {
		_ = database.Close()
		return nil, fmt.Errorf("configure state migrations: %w", err)
	}
	if _, err := provider.Up(ctx); err != nil {
		_ = database.Close()
		return nil, fmt.Errorf("migrate state database: %w", err)
	}
	return &Store{database: database, now: time.Now, newID: randomID}, nil
}

func (s *Store) Close() error {
	if s == nil || s.database == nil {
		return nil
	}
	if err := s.database.Close(); err != nil {
		return fmt.Errorf("close state database: %w", err)
	}
	return nil
}

func (s *Store) Accept(ctx context.Context, input AcceptInput) (AcceptedMessage, error) {
	if err := input.validate(); err != nil {
		return AcceptedMessage{}, err
	}
	conversationID, err := s.newID()
	if err != nil {
		return AcceptedMessage{}, fmt.Errorf("generate conversation ID: %w", err)
	}
	runID, err := s.newID()
	if err != nil {
		return AcceptedMessage{}, fmt.Errorf("generate run ID: %w", err)
	}
	ingressRecordID, err := s.newID()
	if err != nil {
		return AcceptedMessage{}, fmt.Errorf("generate ingress record ID: %w", err)
	}
	messageRecordID, err := s.newID()
	if err != nil {
		return AcceptedMessage{}, fmt.Errorf("generate message record ID: %w", err)
	}
	commitID, err := s.newID()
	if err != nil {
		return AcceptedMessage{}, fmt.Errorf("generate commit ID: %w", err)
	}
	runRecordID, err := s.newID()
	if err != nil {
		return AcceptedMessage{}, fmt.Errorf("generate run record ID: %w", err)
	}
	conversationRecordID, err := s.newID()
	if err != nil {
		return AcceptedMessage{}, fmt.Errorf("generate conversation record ID: %w", err)
	}

	transaction, err := s.database.BeginTx(ctx, nil)
	if err != nil {
		return AcceptedMessage{}, fmt.Errorf("begin accepting message: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()
	queries := conversationdb.New(transaction)

	duplicate, err := duplicateMessage(ctx, queries, input.SourceNamespace, input.SourceEventID)
	if err != nil {
		return AcceptedMessage{}, err
	}
	if duplicate != nil {
		if err := transaction.Commit(); err != nil {
			return AcceptedMessage{}, fmt.Errorf("finish duplicate message lookup: %w", err)
		}
		return *duplicate, nil
	}

	now := s.now().UTC()
	nowMS := now.UnixMilli()
	conversation, err := queries.UpsertConversation(ctx, conversationdb.UpsertConversationParams{
		ID:               conversationID,
		Platform:         input.Route.Platform,
		AccountID:        input.Route.AccountID,
		ExternalChatID:   input.Route.ChatID,
		ExternalThreadID: input.Route.ThreadID,
		CreatedAtMs:      nowMS,
		UpdatedAtMs:      nowMS,
	})
	if err != nil {
		return AcceptedMessage{}, fmt.Errorf("upsert conversation: %w", err)
	}
	isNewConversation := conversation.ID == conversationID
	conversationID = conversation.ID
	if isNewConversation {
		conversationPayload, marshalErr := json.Marshal(ConversationCreatedPayload{
			Platform: input.Route.Platform, AccountID: input.Route.AccountID,
			ExternalChatID: input.Route.ChatID, ExternalThreadID: input.Route.ThreadID,
		})
		if marshalErr != nil {
			return AcceptedMessage{}, fmt.Errorf("encode conversation record: %w", marshalErr)
		}
		conversationRecord, recordErr := newRecord(
			conversationRecordID, commitID, RecordKindConversationCreated, conversationPayload, now,
		)
		if recordErr != nil {
			return AcceptedMessage{}, recordErr
		}
		conversationRecord.ConversationID = conversationID
		if _, appendErr := appendRecord(ctx, queries, conversationRecord); appendErr != nil {
			return AcceptedMessage{}, appendErr
		}
	}

	runStatus := "queued"
	run, err := queries.GetOpenRun(ctx, conversationID)
	if errors.Is(err, sql.ErrNoRows) {
		inputNotBeforeMS := now.Add(input.Run.InputWindow).UnixMilli()
		runPayload, marshalErr := json.Marshal(RunCreatedPayload{
			Provider: input.Run.Provider, Model: input.Run.Model,
			ReasoningEffort: input.Run.ReasoningEffort,
			SystemPrompt:    input.Run.SystemPrompt, Config: input.Run.Config,
			InputWindowMS: input.Run.InputWindow.Milliseconds(), InputNotBeforeMS: inputNotBeforeMS,
		})
		if marshalErr != nil {
			return AcceptedMessage{}, fmt.Errorf("encode run record: %w", marshalErr)
		}
		runRecord, recordErr := newRecord(runRecordID, commitID, RecordKindRunCreated, runPayload, now)
		if recordErr != nil {
			return AcceptedMessage{}, recordErr
		}
		runRecord.ConversationID = conversationID
		runRecord.RunID = runID
		queueSeq, appendErr := appendRecord(ctx, queries, runRecord)
		if appendErr != nil {
			return AcceptedMessage{}, appendErr
		}
		if err := queries.InsertRun(ctx, conversationdb.InsertRunParams{
			ID:               runID,
			ConversationID:   conversationID,
			QueueSeq:         queueSeq,
			Provider:         input.Run.Provider,
			Model:            input.Run.Model,
			ReasoningEffort:  nullableString(input.Run.ReasoningEffort),
			SystemPrompt:     input.Run.SystemPrompt,
			ConfigJson:       nullableJSON(input.Run.Config),
			CreatedAtMs:      nowMS,
			InputNotBeforeMs: sql.NullInt64{Int64: inputNotBeforeMS, Valid: true},
		}); err != nil {
			return AcceptedMessage{}, fmt.Errorf("insert run: %w", err)
		}
	} else if err != nil {
		return AcceptedMessage{}, fmt.Errorf("find open run: %w", err)
	} else {
		runID = run.ID
		runStatus = run.Status
	}

	ingressRecord, err := newRecord(ingressRecordID, commitID, RecordKindIngressReceived, input.IngressPayload, now)
	if err != nil {
		return AcceptedMessage{}, err
	}
	ingressRecord.ConversationID = conversationID
	ingressRecord.RunID = runID
	ingressRecord.SourceNamespace = input.SourceNamespace
	ingressRecord.SourceEventID = input.SourceEventID
	if _, err := appendRecord(ctx, queries, ingressRecord); err != nil {
		return AcceptedMessage{}, err
	}

	messagePayload, err := json.Marshal(MessageRecordPayload{
		Message: input.Message.Message, SourceRecordID: ingressRecordID,
	})
	if err != nil {
		return AcceptedMessage{}, fmt.Errorf("encode user message record: %w", err)
	}
	messageRecord, err := newRecord(messageRecordID, commitID, RecordKindMessageCreated, messagePayload, now)
	if err != nil {
		return AcceptedMessage{}, err
	}
	messageRecord.ConversationID = conversationID
	messageRecord.RunID = runID
	if _, err := appendRecord(ctx, queries, messageRecord); err != nil {
		return AcceptedMessage{}, err
	}
	if err := insertBlobs(ctx, queries, messageRecordID, input.Message.Blobs, nowMS); err != nil {
		return AcceptedMessage{}, err
	}
	if err := queries.InsertMessage(ctx, conversationdb.InsertMessageParams{
		RecordID:       messageRecordID,
		ConversationID: conversationID,
		RunID:          runID,
		SourceRecordID: sql.NullString{String: ingressRecordID, Valid: true},
		Role:           input.Message.Message.Role,
	}); err != nil {
		return AcceptedMessage{}, fmt.Errorf("insert user message: %w", err)
	}
	advanced, err := queries.AdvanceRunInput(ctx, conversationdb.AdvanceRunInputParams{
		InputNotBeforeMs: sql.NullInt64{
			Int64: now.Add(input.Run.InputWindow).UnixMilli(), Valid: true,
		},
		ID: runID,
	})
	if err != nil {
		return AcceptedMessage{}, fmt.Errorf("advance run input: %w", err)
	}
	interruptRequested := advanced.Status == "running"
	if interruptRequested {
		recordID, idErr := s.newID()
		if idErr != nil {
			return AcceptedMessage{}, fmt.Errorf("generate interrupt record ID: %w", idErr)
		}
		payload, marshalErr := json.Marshal(InterruptRequestedPayload{
			InputRevision:    advanced.InputRevision,
			InputNotBeforeMS: advanced.InputNotBeforeMs.Int64,
		})
		if marshalErr != nil {
			return AcceptedMessage{}, fmt.Errorf("encode interrupt record: %w", marshalErr)
		}
		record, recordErr := newRecord(recordID, commitID, RecordKindInterruptRequested, payload, now)
		if recordErr != nil {
			return AcceptedMessage{}, recordErr
		}
		record.ConversationID = conversationID
		record.RunID = runID
		if _, appendErr := appendRecord(ctx, queries, record); appendErr != nil {
			return AcceptedMessage{}, appendErr
		}
	}
	if err := transaction.Commit(); err != nil {
		return AcceptedMessage{}, fmt.Errorf("commit accepting message: %w", err)
	}
	return AcceptedMessage{
		ConversationID: conversationID, RunID: runID, RunStatus: runStatus,
		IngressRecordID: ingressRecordID, MessageRecordID: messageRecordID,
		InputRevision: advanced.InputRevision, InterruptRequested: interruptRequested,
	}, nil
}

func (s *Store) LoadBlob(ctx context.Context, digest BlobDigest) ([]byte, error) {
	data, err := conversationdb.New(s.database).GetBlob(ctx, digest[:])
	if err != nil {
		return nil, fmt.Errorf("load blob %s: %w", digest, err)
	}
	if DigestBlob(data) != digest {
		return nil, fmt.Errorf("blob %s digest does not match content", digest)
	}
	return data, nil
}

func (s *Store) Records(ctx context.Context) ([]Record, error) {
	rows, err := conversationdb.New(s.database).ListRecords(ctx)
	if err != nil {
		return nil, fmt.Errorf("list records: %w", err)
	}
	records := make([]Record, len(rows))
	for index, row := range rows {
		record, convertErr := recordFromDatabase(row)
		if convertErr != nil {
			return nil, fmt.Errorf("record %d: %w", index, convertErr)
		}
		records[index] = record
	}
	return records, nil
}

func (input *AcceptInput) validate() error {
	input.Route.Platform = strings.TrimSpace(input.Route.Platform)
	input.Route.AccountID = strings.TrimSpace(input.Route.AccountID)
	input.Route.ChatID = strings.TrimSpace(input.Route.ChatID)
	input.Route.ThreadID = strings.TrimSpace(input.Route.ThreadID)
	input.SourceNamespace = strings.TrimSpace(input.SourceNamespace)
	input.SourceEventID = strings.TrimSpace(input.SourceEventID)
	input.Run.Provider = strings.TrimSpace(input.Run.Provider)
	input.Run.Model = strings.TrimSpace(input.Run.Model)
	if input.Route.Platform == "" || input.Route.AccountID == "" || input.Route.ChatID == "" {
		return errors.New("conversation route is incomplete")
	}
	if input.SourceNamespace == "" || input.SourceEventID == "" {
		return errors.New("source identity is incomplete")
	}
	if !json.Valid(input.IngressPayload) {
		return errors.New("ingress payload is not valid JSON")
	}
	if input.Message.Message.Role != "user" {
		return errors.New("accepted message role must be user")
	}
	if input.Run.Provider == "" || input.Run.Model == "" {
		return errors.New("run provider and model are required")
	}
	if input.Run.InputWindow < 0 {
		return errors.New("run input window must be non-negative")
	}
	if len(input.Run.Config) > 0 && !json.Valid(input.Run.Config) {
		return errors.New("run config is not valid JSON")
	}
	return nil
}

func duplicateMessage(
	ctx context.Context,
	queries *conversationdb.Queries,
	namespace string,
	eventID string,
) (*AcceptedMessage, error) {
	record, err := queries.GetIngressRecord(ctx, conversationdb.GetIngressRecordParams{
		SourceNamespace: sql.NullString{String: namespace, Valid: true},
		SourceEventID:   sql.NullString{String: eventID, Valid: true},
	})
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("find ingress record: %w", err)
	}
	message, err := queries.GetMessageBySourceRecord(ctx, sql.NullString{String: record.ID, Valid: true})
	if err != nil {
		return nil, fmt.Errorf("find ingress message: %w", err)
	}
	run, err := queries.GetRun(ctx, message.RunID)
	if err != nil {
		return nil, fmt.Errorf("find ingress run: %w", err)
	}
	return &AcceptedMessage{
		ConversationID: record.ConversationID.String, RunID: message.RunID, RunStatus: run.Status,
		IngressRecordID: record.ID, MessageRecordID: message.RecordID,
		InputRevision: run.InputRevision, Duplicate: true,
	}, nil
}

func newRecord(id, commitID string, kind RecordKind, payload json.RawMessage, now time.Time) (Record, error) {
	record, err := NewRecord(id, commitID, kind, RecordSchemaVersion, payload)
	if err != nil {
		return Record{}, fmt.Errorf("create %s record: %w", kind, err)
	}
	record.CreatedAt = now
	return record, nil
}

func appendRecord(ctx context.Context, queries *conversationdb.Queries, record Record) (int64, error) {
	if err := record.Validate(); err != nil {
		return 0, fmt.Errorf("validate %s record: %w", record.Kind, err)
	}
	seq, err := queries.InsertRecord(ctx, conversationdb.InsertRecordParams{
		ID:              record.ID,
		CommitID:        record.CommitID,
		ConversationID:  nullableString(record.ConversationID),
		RunID:           nullableString(record.RunID),
		Kind:            string(record.Kind),
		SchemaVersion:   int64(record.SchemaVersion),
		SourceNamespace: nullableString(record.SourceNamespace),
		SourceEventID:   nullableString(record.SourceEventID),
		PayloadJson:     string(record.Payload),
		PayloadSha256:   record.PayloadSHA256[:],
		CreatedAtMs:     record.CreatedAt.UnixMilli(),
	})
	if err != nil {
		return 0, fmt.Errorf("insert %s record: %w", record.Kind, err)
	}
	return seq, nil
}

func insertBlobs(
	ctx context.Context,
	queries *conversationdb.Queries,
	recordID string,
	blobs []EncodedBlob,
	createdAtMS int64,
) error {
	for _, encoded := range blobs {
		if encoded.PartIndex < 0 {
			return errors.New("blob part index must be non-negative")
		}
		if DigestBlob(encoded.Blob.Data) != encoded.Blob.Digest {
			return fmt.Errorf("blob for part %d has invalid digest", encoded.PartIndex)
		}
		if err := queries.InsertBlob(ctx, conversationdb.InsertBlobParams{
			Sha256: encoded.Blob.Digest[:], Data: encoded.Blob.Data, CreatedAtMs: createdAtMS,
		}); err != nil {
			return fmt.Errorf("insert blob for part %d: %w", encoded.PartIndex, err)
		}
		if err := queries.InsertRecordBlob(ctx, conversationdb.InsertRecordBlobParams{
			RecordID: recordID, PartIndex: int64(encoded.PartIndex), Sha256: encoded.Blob.Digest[:],
		}); err != nil {
			return fmt.Errorf("link blob for part %d: %w", encoded.PartIndex, err)
		}
	}
	return nil
}

func recordFromDatabase(row conversationdb.Record) (Record, error) {
	if len(row.PayloadSha256) != 32 {
		return Record{}, fmt.Errorf("payload digest has %d bytes", len(row.PayloadSha256))
	}
	var digest [32]byte
	copy(digest[:], row.PayloadSha256)
	record := Record{
		Seq:             row.Seq,
		ID:              row.ID,
		CommitID:        row.CommitID,
		ConversationID:  row.ConversationID.String,
		RunID:           row.RunID.String,
		Kind:            RecordKind(row.Kind),
		SchemaVersion:   int(row.SchemaVersion),
		SourceNamespace: row.SourceNamespace.String,
		SourceEventID:   row.SourceEventID.String,
		Payload:         json.RawMessage(row.PayloadJson),
		PayloadSHA256:   digest,
		CreatedAt:       time.UnixMilli(row.CreatedAtMs).UTC(),
	}
	if err := record.Validate(); err != nil {
		return Record{}, err
	}
	return record, nil
}

func nullableString(value string) sql.NullString {
	return sql.NullString{String: value, Valid: value != ""}
}

func nullableJSON(value json.RawMessage) sql.NullString {
	return sql.NullString{String: string(value), Valid: len(value) > 0}
}

func randomID() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", err
	}
	value[6] = value[6]&0x0f | 0x40
	value[8] = value[8]&0x3f | 0x80
	var encoded [36]byte
	hex.Encode(encoded[0:8], value[0:4])
	encoded[8] = '-'
	hex.Encode(encoded[9:13], value[4:6])
	encoded[13] = '-'
	hex.Encode(encoded[14:18], value[6:8])
	encoded[18] = '-'
	hex.Encode(encoded[19:23], value[8:10])
	encoded[23] = '-'
	hex.Encode(encoded[24:36], value[10:16])
	return string(encoded[:]), nil
}
