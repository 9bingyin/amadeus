package vector

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"sync"
	"time"

	"github.com/9bingyin/amadeus/internal/conversation"
	sqlitevec "github.com/asg017/sqlite-vec-go-bindings/ncruces"
	"github.com/ncruces/go-sqlite3"
)

type Embedder interface {
	Embed(ctx context.Context, text string) ([]float32, error)
}

type Index struct {
	mu        sync.Mutex
	conn      *sqlite3.Conn
	embed     Embedder
	dimension int
	rebuild   chan struct{}
	phase     string
}

const (
	PhaseIdle       = "idle"
	PhaseIndexing   = "indexing"
	PhaseWaiting    = "waiting"
	PhaseRebuilding = "rebuilding"
)

var errDimensionChanged = errors.New("session vector dimension changed")

func Open(path string, embed Embedder) (*Index, error) {
	if path == "" {
		return nil, fmt.Errorf("session vector database path is required")
	}
	if embed == nil {
		return nil, fmt.Errorf("session vector embedder is required")
	}
	query := url.Values{}
	query.Add("_pragma", "busy_timeout(5000)")
	dsn := (&url.URL{Scheme: "file", Path: path, RawQuery: query.Encode()}).String()
	conn, err := sqlite3.Open(dsn)
	if err != nil {
		return nil, fmt.Errorf("open session vectors: %w", err)
	}
	index := &Index{conn: conn, embed: embed, rebuild: make(chan struct{}, 1)}
	if err := os.Chmod(path, 0o600); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("secure session vectors: %w", err)
	}
	if err := index.exec(`SELECT vec_version()`, nil); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("open session vectors: %w", err)
	}
	if err := index.exec(`
CREATE TABLE IF NOT EXISTS vec_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    dimension INTEGER NOT NULL
)`, nil); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("open session vectors: %w", err)
	}
	if err := index.exec(`
CREATE TABLE IF NOT EXISTS vec_docs (
    message_record_id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL
)`, nil); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("open session vectors: %w", err)
	}
	var dimension int
	err = index.query(`SELECT dimension FROM vec_meta WHERE id = 1`, nil, func(stmt *sqlite3.Stmt) error {
		dimension = stmt.ColumnInt(0)
		return nil
	})
	if err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("open session vectors: %w", err)
	}
	index.dimension = dimension
	return index, nil
}

func (idx *Index) Close() error {
	if idx == nil {
		return nil
	}
	idx.mu.Lock()
	defer idx.mu.Unlock()
	if idx.conn == nil {
		return nil
	}
	err := idx.conn.Close()
	idx.conn = nil
	if err != nil {
		return fmt.Errorf("close session vectors: %w", err)
	}
	return nil
}

func (idx *Index) Run(
	ctx context.Context,
	documents func(context.Context) ([]conversation.SearchDocument, error),
	updates <-chan struct{},
	retryAfter time.Duration,
) {
	for {
		err := idx.syncMissing(ctx, documents)
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			slog.ErrorContext(ctx, "Session vector indexing failed", "err", err)
			idx.setPhase(PhaseWaiting)
			if !waitForVectorRetry(ctx, retryAfter) {
				return
			}
			continue
		}
		idx.setPhase(PhaseIdle)
		if !idx.waitForVectors(ctx, updates) {
			return
		}
	}
}

func (idx *Index) setPhase(phase string) {
	idx.mu.Lock()
	idx.phase = phase
	idx.mu.Unlock()
}

func (idx *Index) ConversationProgress(conversationID string) (int, string, error) {
	idx.mu.Lock()
	defer idx.mu.Unlock()
	if idx.conn == nil {
		return 0, PhaseIdle, fmt.Errorf("session vectors are closed")
	}
	var done int
	err := idx.query(`SELECT COUNT(*) FROM vec_docs WHERE conversation_id = ?`, func(stmt *sqlite3.Stmt) error {
		return stmt.BindText(1, conversationID)
	}, func(stmt *sqlite3.Stmt) error {
		done = stmt.ColumnInt(0)
		return nil
	})
	if err != nil {
		return 0, PhaseIdle, fmt.Errorf("count session vectors: %w", err)
	}
	phase := idx.phase
	if phase == "" {
		phase = PhaseIdle
	}
	return done, phase, nil
}

func waitForVectorRetry(ctx context.Context, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func (idx *Index) waitForVectors(ctx context.Context, updates <-chan struct{}) bool {
	select {
	case <-ctx.Done():
		return false
	case <-updates:
		return true
	case <-idx.rebuild:
		return true
	}
}

func (idx *Index) noteRebuild() {
	select {
	case idx.rebuild <- struct{}{}:
	default:
	}
}

func (idx *Index) syncMissing(
	ctx context.Context,
	documents func(context.Context) ([]conversation.SearchDocument, error),
) error {
	docs, err := documents(ctx)
	if err != nil {
		return err
	}
	idx.setPhase(PhaseIndexing)
	if err := idx.syncOnce(ctx, docs, true); err != nil {
		if errors.Is(err, errDimensionChanged) {
			idx.setPhase(PhaseRebuilding)
			return idx.syncOnce(ctx, docs, false)
		}
		return err
	}
	return nil
}

func (idx *Index) syncOnce(ctx context.Context, docs []conversation.SearchDocument, allowReset bool) error {
	indexed, err := idx.indexedIDs()
	if err != nil {
		return err
	}
	for _, doc := range docs {
		if doc.RecordID == "" || doc.Body == "" {
			continue
		}
		if _, ok := indexed[doc.RecordID]; ok {
			continue
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := idx.indexDocument(ctx, doc, allowReset); err != nil {
			return err
		}
		indexed[doc.RecordID] = struct{}{}
	}
	return nil
}

func (idx *Index) indexDocument(ctx context.Context, doc conversation.SearchDocument, allowReset bool) error {
	embedding, err := idx.embed.Embed(ctx, doc.Body)
	if err != nil {
		return err
	}
	if len(embedding) == 0 {
		return fmt.Errorf("embedding response is empty")
	}
	blob, err := sqlitevec.SerializeFloat32(embedding)
	if err != nil {
		return fmt.Errorf("encode embedding for %s: %w", doc.RecordID, err)
	}
	idx.mu.Lock()
	defer idx.mu.Unlock()
	if idx.conn == nil {
		return fmt.Errorf("session vectors are closed")
	}
	if idx.dimension != 0 && idx.dimension != len(embedding) {
		if !allowReset {
			return fmt.Errorf("search embedding dimension is %d, model returned %d", idx.dimension, len(embedding))
		}
		if err := idx.resetLocked(len(embedding)); err != nil {
			return err
		}
		return errDimensionChanged
	}
	if err := idx.ensureTable(len(embedding)); err != nil {
		return err
	}
	if err := idx.conn.Exec("BEGIN IMMEDIATE"); err != nil {
		return fmt.Errorf("begin session vector insert: %w", err)
	}
	if err := idx.insert(doc, blob); err != nil {
		_ = idx.conn.Exec("ROLLBACK")
		return err
	}
	if err := idx.conn.Exec("COMMIT"); err != nil {
		_ = idx.conn.Exec("ROLLBACK")
		return fmt.Errorf("commit session vector insert: %w", err)
	}
	return nil
}

func (idx *Index) indexedIDs() (map[string]struct{}, error) {
	idx.mu.Lock()
	defer idx.mu.Unlock()
	if idx.conn == nil {
		return nil, fmt.Errorf("session vectors are closed")
	}
	indexed := map[string]struct{}{}
	err := idx.query(`SELECT message_record_id FROM vec_docs`, nil, func(stmt *sqlite3.Stmt) error {
		indexed[stmt.ColumnText(0)] = struct{}{}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("list session vectors: %w", err)
	}
	return indexed, nil
}

func (idx *Index) Search(ctx context.Context, conversationID, query string, limit int) ([]string, bool, error) {
	if limit < 1 {
		return nil, false, fmt.Errorf("limit must be positive")
	}
	idx.mu.Lock()
	closed := idx.conn == nil
	dimension := idx.dimension
	idx.mu.Unlock()
	if closed {
		return nil, false, fmt.Errorf("session vectors are closed")
	}
	if dimension == 0 {
		return nil, false, nil
	}
	embedding, err := idx.embed.Embed(ctx, query)
	if err != nil {
		return nil, false, err
	}
	idx.mu.Lock()
	defer idx.mu.Unlock()
	if idx.conn == nil {
		return nil, false, fmt.Errorf("session vectors are closed")
	}
	if idx.dimension != len(embedding) {
		if idx.dimension != 0 {
			if err := idx.resetLocked(len(embedding)); err != nil {
				return nil, false, err
			}
		}
		idx.noteRebuild()
		return nil, false, nil
	}
	blob, err := sqlitevec.SerializeFloat32(embedding)
	if err != nil {
		return nil, false, fmt.Errorf("encode query embedding: %w", err)
	}
	previous := idx.conn.SetInterrupt(ctx)
	defer idx.conn.SetInterrupt(previous)
	var ids []string
	err = idx.query(`
SELECT message_record_id, distance
FROM message_vec
WHERE embedding MATCH ?
  AND k = ?
  AND conversation_id = ?`, func(stmt *sqlite3.Stmt) error {
		if err := stmt.BindBlob(1, blob); err != nil {
			return err
		}
		if err := stmt.BindInt(2, limit+1); err != nil {
			return err
		}
		return stmt.BindText(3, conversationID)
	}, func(stmt *sqlite3.Stmt) error {
		ids = append(ids, stmt.ColumnText(0))
		return nil
	})
	if err != nil {
		return nil, false, fmt.Errorf("search session vectors: %w", err)
	}
	more := len(ids) > limit
	if more {
		ids = ids[:limit]
	}
	return ids, more, nil
}

func (idx *Index) resetLocked(next int) error {
	idx.phase = PhaseRebuilding
	slog.Info("Rebuilding session vectors", "from", idx.dimension, "to", next)
	if err := idx.exec(`DROP TABLE IF EXISTS message_vec`, nil); err != nil {
		return fmt.Errorf("drop session vectors: %w", err)
	}
	if err := idx.exec(`DELETE FROM vec_docs`, nil); err != nil {
		return fmt.Errorf("clear session vector documents: %w", err)
	}
	if err := idx.exec(`DELETE FROM vec_meta`, nil); err != nil {
		return fmt.Errorf("clear session vector dimension: %w", err)
	}
	idx.dimension = 0
	return nil
}

func (idx *Index) ensureTable(dimension int) error {
	if idx.dimension == 0 {
		statement := fmt.Sprintf(`
CREATE VIRTUAL TABLE message_vec USING vec0(
    message_record_id text primary key,
    embedding float[%d],
    conversation_id text partition key
)`, dimension)
		if err := idx.exec(statement, nil); err != nil {
			return fmt.Errorf("create session vectors: %w", err)
		}
		if err := idx.exec(`INSERT INTO vec_meta (id, dimension) VALUES (1, ?)`, func(stmt *sqlite3.Stmt) error {
			return stmt.BindInt(1, dimension)
		}); err != nil {
			return fmt.Errorf("store session vector dimension: %w", err)
		}
		idx.dimension = dimension
		return nil
	}
	if dimension != idx.dimension {
		return fmt.Errorf("search embedding dimension is %d, model returned %d", idx.dimension, dimension)
	}
	return nil
}

func (idx *Index) insert(doc conversation.SearchDocument, blob []byte) error {
	if err := idx.exec(`
INSERT INTO message_vec (message_record_id, embedding, conversation_id)
VALUES (?, ?, ?)`, func(stmt *sqlite3.Stmt) error {
		if err := stmt.BindText(1, doc.RecordID); err != nil {
			return err
		}
		if err := stmt.BindBlob(2, blob); err != nil {
			return err
		}
		return stmt.BindText(3, doc.ConversationID)
	}); err != nil {
		return fmt.Errorf("insert session vector %s: %w", doc.RecordID, err)
	}
	if err := idx.exec(`
INSERT INTO vec_docs (message_record_id, conversation_id) VALUES (?, ?)`, func(stmt *sqlite3.Stmt) error {
		if err := stmt.BindText(1, doc.RecordID); err != nil {
			return err
		}
		return stmt.BindText(2, doc.ConversationID)
	}); err != nil {
		return fmt.Errorf("insert session vector %s: %w", doc.RecordID, err)
	}
	return nil
}

func (idx *Index) exec(statement string, bind func(*sqlite3.Stmt) error) error {
	stmt, _, err := idx.conn.Prepare(statement)
	if err != nil {
		return err
	}
	defer func() { _ = stmt.Close() }()
	if bind != nil {
		if err := bind(stmt); err != nil {
			return err
		}
	}
	return stmt.Exec()
}

func (idx *Index) query(statement string, bind func(*sqlite3.Stmt) error, scan func(*sqlite3.Stmt) error) error {
	stmt, _, err := idx.conn.Prepare(statement)
	if err != nil {
		return err
	}
	defer func() { _ = stmt.Close() }()
	if bind != nil {
		if err := bind(stmt); err != nil {
			return err
		}
	}
	for stmt.Step() {
		if err := scan(stmt); err != nil {
			return err
		}
	}
	return stmt.Err()
}
