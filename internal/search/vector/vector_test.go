package vector

import (
	"context"
	"errors"
	"path/filepath"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/9bingyin/amadeus/internal/conversation"
)

func TestSearchRanksNearestDocument(t *testing.T) {
	index, err := Open(filepath.Join(t.TempDir(), "state.db.vec"), staticEmbedder{})
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	t.Cleanup(func() {
		if err := index.Close(); err != nil {
			t.Errorf("Close() error = %v", err)
		}
	})
	docs := []conversation.SearchDocument{
		{RecordID: "near", ConversationID: "chat", Body: "alpha"},
		{RecordID: "far", ConversationID: "chat", Body: "zzzz"},
		{RecordID: "other", ConversationID: "elsewhere", Body: "alpha"},
	}
	for _, doc := range docs {
		if err := index.indexDocument(t.Context(), doc, true); err != nil {
			t.Fatalf("indexDocument() error = %v", err)
		}
	}
	ids, more, err := index.Search(t.Context(), "chat", "alpha", 1)
	if err != nil {
		t.Fatalf("Search() error = %v", err)
	}
	if !more || len(ids) != 1 || ids[0] != "near" {
		t.Fatalf("ids = %#v more=%v", ids, more)
	}
	again, more, err := index.Search(t.Context(), "chat", "alpha", 2)
	if err != nil {
		t.Fatalf("Search() again error = %v", err)
	}
	if more || len(again) != 2 || again[0] != "near" || again[1] != "far" {
		t.Fatalf("again = %#v more=%v", again, more)
	}
}

func TestRunIndexesDocumentsBeforeSearch(t *testing.T) {
	embedder := &countingEmbedder{}
	index, err := Open(filepath.Join(t.TempDir(), "state.db.vec"), embedder)
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	t.Cleanup(func() {
		if err := index.Close(); err != nil {
			t.Errorf("Close() error = %v", err)
		}
	})
	ids, _, err := index.Search(t.Context(), "chat", "alpha", 1)
	if err != nil || len(ids) != 0 || embedder.calls.Load() != 0 {
		t.Fatalf("Search() before index = %#v calls=%d err=%v", ids, embedder.calls.Load(), err)
	}
	var documents sync.Mutex
	docs := []conversation.SearchDocument{{RecordID: "near", ConversationID: "chat", Body: "alpha"}}
	updates := make(chan struct{}, 1)
	ctx, stop := context.WithCancel(t.Context())
	done := make(chan struct{})
	go func() {
		defer close(done)
		index.Run(ctx, func(context.Context) ([]conversation.SearchDocument, error) {
			documents.Lock()
			defer documents.Unlock()
			return slices.Clone(docs), nil
		}, updates, time.Minute)
	}()
	t.Cleanup(func() {
		stop()
		<-done
	})
	waitForIDs(t, index, 1, []string{"near"})
	documents.Lock()
	docs = append(docs, conversation.SearchDocument{RecordID: "far", ConversationID: "chat", Body: "zzzz"})
	documents.Unlock()
	updates <- struct{}{}
	waitForIDs(t, index, 2, []string{"near", "far"})
}

func TestConversationProgressCountsOneChat(t *testing.T) {
	index, err := Open(filepath.Join(t.TempDir(), "state.db.vec"), staticEmbedder{})
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	t.Cleanup(func() {
		if err := index.Close(); err != nil {
			t.Errorf("Close() error = %v", err)
		}
	})
	for _, doc := range []conversation.SearchDocument{
		{RecordID: "near", ConversationID: "chat", Body: "alpha"},
		{RecordID: "other", ConversationID: "elsewhere", Body: "alpha"},
	} {
		if err := index.indexDocument(t.Context(), doc, true); err != nil {
			t.Fatalf("indexDocument() error = %v", err)
		}
	}
	done, phase, err := index.ConversationProgress("chat")
	if err != nil || done != 1 || phase != PhaseIdle {
		t.Fatalf("progress = %d %q err=%v", done, phase, err)
	}
}

func TestDimensionChangeRebuildsVectors(t *testing.T) {
	index, err := Open(filepath.Join(t.TempDir(), "state.db.vec"), staticEmbedder{})
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	t.Cleanup(func() {
		if err := index.Close(); err != nil {
			t.Errorf("Close() error = %v", err)
		}
	})
	original := conversation.SearchDocument{RecordID: "near", ConversationID: "chat", Body: "alpha"}
	if err := index.indexDocument(t.Context(), original, true); err != nil {
		t.Fatalf("indexDocument() error = %v", err)
	}
	index.embed = wideEmbedder{}
	err = index.syncMissing(t.Context(), func(context.Context) ([]conversation.SearchDocument, error) {
		return []conversation.SearchDocument{
			original,
			{RecordID: "far", ConversationID: "chat", Body: "zzzz"},
		}, nil
	})
	if err != nil {
		t.Fatalf("syncMissing() error = %v", err)
	}
	if index.dimension != 8 {
		t.Fatalf("dimension = %d, want 8", index.dimension)
	}
	ids, more, err := index.Search(t.Context(), "chat", "alpha", 2)
	if err != nil || more || len(ids) != 2 || ids[0] != "near" || ids[1] != "far" {
		t.Fatalf("Search() = %#v more=%v err=%v", ids, more, err)
	}
}

type wideEmbedder struct{}

func (wideEmbedder) Embed(_ context.Context, text string) ([]float32, error) {
	vector := make([]float32, 8)
	for _, char := range text {
		vector[int(char)%len(vector)]++
	}
	return vector, nil
}

func TestRunRetriesIndexingAfterDelay(t *testing.T) {
	embedder := &failingEmbedder{failures: 1, err: errors.New("api error 429: Rate limit exceeded")}
	index, err := Open(filepath.Join(t.TempDir(), "state.db.vec"), embedder)
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	t.Cleanup(func() {
		if err := index.Close(); err != nil {
			t.Errorf("Close() error = %v", err)
		}
	})
	docs := []conversation.SearchDocument{{RecordID: "near", ConversationID: "chat", Body: "alpha"}}
	ctx, stop := context.WithCancel(t.Context())
	done := make(chan struct{})
	const retryAfter = 30 * time.Millisecond
	go func() {
		defer close(done)
		index.Run(ctx, func(context.Context) ([]conversation.SearchDocument, error) {
			return docs, nil
		}, nil, retryAfter)
	}()
	t.Cleanup(func() {
		stop()
		<-done
	})
	waitForIDs(t, index, 1, []string{"near"})
	embedder.mu.Lock()
	attempts := append([]time.Time(nil), embedder.attempts...)
	embedder.mu.Unlock()
	if len(attempts) < 2 || attempts[1].Sub(attempts[0]) < retryAfter {
		t.Fatalf("attempts = %v, want a retry after %s", attempts, retryAfter)
	}
}

func waitForIDs(t *testing.T, index *Index, limit int, want []string) {
	t.Helper()
	for {
		ids, _, err := index.Search(t.Context(), "chat", "alpha", limit)
		if err != nil {
			t.Fatalf("Search() error = %v", err)
		}
		if slices.Equal(ids, want) {
			return
		}
		select {
		case <-t.Context().Done():
			t.Fatalf("search = %#v, want %#v", ids, want)
		case <-time.After(time.Millisecond):
		}
	}
}

type failingEmbedder struct {
	mu       sync.Mutex
	failures int
	err      error
	attempts []time.Time
}

func (e *failingEmbedder) Embed(ctx context.Context, text string) ([]float32, error) {
	e.mu.Lock()
	e.attempts = append(e.attempts, time.Now())
	fail := e.failures > 0
	if fail {
		e.failures--
	}
	e.mu.Unlock()
	if fail {
		return nil, e.err
	}
	return staticEmbedder{}.Embed(ctx, text)
}

type countingEmbedder struct {
	calls atomic.Int32
}

func (e *countingEmbedder) Embed(ctx context.Context, text string) ([]float32, error) {
	e.calls.Add(1)
	return staticEmbedder{}.Embed(ctx, text)
}

type staticEmbedder struct{}

func (staticEmbedder) Embed(_ context.Context, text string) ([]float32, error) {
	vector := make([]float32, 4)
	for _, char := range text {
		vector[int(char)%len(vector)]++
	}
	return vector, nil
}
