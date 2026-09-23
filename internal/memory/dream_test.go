package memory

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDreamShortensAFullListOnce(t *testing.T) {
	store := openMemory(t)
	if _, err := store.Apply("user", "add", strings.Repeat("a", 1116), ""); err != nil {
		t.Fatalf("Apply() error = %v", err)
	}
	if _, ok, err := store.NextDream(); err != nil || ok {
		t.Fatalf("NextDream() below threshold = %v, %v", ok, err)
	}
	if _, err := store.Apply("user", "add", "beta", ""); err != nil {
		t.Fatalf("Apply() error = %v", err)
	}
	dream, ok, err := store.NextDream()
	if err != nil || !ok || dream.Target != "user" || dream.Limit != userLimit {
		t.Fatalf("NextDream() = %+v, %v, %v", dream, ok, err)
	}
	applied, err := store.AcceptDream(dream.Target, dream.Text, "```markdown\n- kept\n```")
	if err != nil || !applied {
		t.Fatalf("AcceptDream() = %v, %v", applied, err)
	}
	user, _, err := store.Load()
	if err != nil || user != "- kept" {
		t.Fatalf("Load() = %q, %v", user, err)
	}
	if _, ok, err := store.NextDream(); err != nil || ok {
		t.Fatalf("NextDream() after shorten = %v, %v", ok, err)
	}
	info, err := os.Stat(filepath.Join(store.dir, dreamStateFile))
	if err != nil {
		t.Fatalf("Stat() error = %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("dream state mode = %o, want 600", info.Mode().Perm())
	}
}

func TestDreamKeepsTheListWhenTheRewriteIsNotShorter(t *testing.T) {
	store := openMemory(t)
	if _, err := store.Apply("memory", "add", strings.Repeat("m", 1758), ""); err != nil {
		t.Fatalf("Apply() error = %v", err)
	}
	dream, ok, err := store.NextDream()
	if err != nil || !ok || dream.Target != "memory" {
		t.Fatalf("NextDream() = %+v, %v, %v", dream, ok, err)
	}
	applied, err := store.AcceptDream(dream.Target, dream.Text, dream.Text+"\n- extra")
	if err != nil || applied {
		t.Fatalf("AcceptDream() = %v, %v", applied, err)
	}
	if _, ok, err := store.NextDream(); err != nil || ok {
		t.Fatalf("NextDream() after rejected rewrite = %v, %v", ok, err)
	}
	_, facts, err := store.Load()
	if err != nil || facts != dream.Text {
		t.Fatalf("Load() = %q, %v", facts, err)
	}
}

func TestDreamRetriesWhenTheListChangesOrStaysFull(t *testing.T) {
	store := openMemory(t)
	if _, err := store.Apply("user", "add", strings.Repeat("a", 1300), ""); err != nil {
		t.Fatalf("Apply() error = %v", err)
	}
	dream, ok, err := store.NextDream()
	if err != nil || !ok {
		t.Fatalf("NextDream() = %+v, %v, %v", dream, ok, err)
	}
	if err := store.SkipDream(dream.Target, dream.Text+" changed"); err != nil {
		t.Fatalf("SkipDream() error = %v", err)
	}
	again, ok, err := store.NextDream()
	if err != nil || !ok || again.Text != dream.Text {
		t.Fatalf("NextDream() after skipped mismatch = %+v, %v, %v", again, ok, err)
	}
	kept := "- " + strings.Repeat("b", 1198)
	applied, err := store.AcceptDream(again.Target, again.Text, kept)
	if err != nil || !applied {
		t.Fatalf("AcceptDream() = %v, %v", applied, err)
	}
	next, ok, err := store.NextDream()
	if err != nil || !ok || next.Text != kept {
		t.Fatalf("NextDream() still full = %+v, %v, %v", next, ok, err)
	}
	if err := store.SkipDream(next.Target, next.Text); err != nil {
		t.Fatalf("SkipDream() error = %v", err)
	}
	if _, ok, err := store.NextDream(); err != nil || ok {
		t.Fatalf("NextDream() after skip = %v, %v", ok, err)
	}
}
