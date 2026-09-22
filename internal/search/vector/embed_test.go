package vector

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/felinics/twilight/provider/openai/embedding"
)

func TestModelEmbedder(t *testing.T) {
	fail := false
	var gotAuth, gotPath, gotBody string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if fail {
			http.Error(w, `{"error":{"message":"bad model"}}`, http.StatusBadRequest)
			return
		}
		gotAuth = r.Header.Get("Authorization")
		gotPath = r.URL.Path
		body, _ := io.ReadAll(r.Body)
		gotBody = string(body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"embedding":[0.25,0.5],"index":0,"object":"embedding"}],"model":"text-embedding-3-small","usage":{"prompt_tokens":1,"total_tokens":1}}`))
	}))
	t.Cleanup(server.Close)

	embedder, err := NewModelEmbedder(embedding.New(
		embedding.WithAPIKey("secret-key"),
		embedding.WithBaseURL(server.URL+"/v1"),
	).EmbeddingModel("text-embedding-3-small"))
	if err != nil {
		t.Fatalf("NewModelEmbedder() error = %v", err)
	}
	values, err := embedder.Embed(t.Context(), "hello")
	if err != nil {
		t.Fatalf("Embed() error = %v", err)
	}
	if len(values) != 2 || values[0] != 0.25 || values[1] != 0.5 {
		t.Fatalf("embedding = %#v", values)
	}
	if gotAuth != "Bearer secret-key" || gotPath != "/v1/embeddings" || !strings.Contains(gotBody, `"model":"text-embedding-3-small"`) || !strings.Contains(gotBody, `"input":["hello"]`) {
		t.Fatalf("request auth=%q path=%q body=%s", gotAuth, gotPath, gotBody)
	}

	fail = true
	_, err = embedder.Embed(t.Context(), "hello")
	if err == nil || !strings.Contains(err.Error(), "bad model") {
		t.Fatalf("Embed() error = %v", err)
	}
}
