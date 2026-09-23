package memory

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestApplyUpdatesUserAndMemory(t *testing.T) {
	store := openMemory(t)
	saved, err := store.Apply("user", "add", "Prefers short replies", "")
	if err != nil {
		t.Fatalf("Apply() add user error = %v", err)
	}
	if saved != "saved user\n- Prefers short replies" {
		t.Fatalf("Apply() add user = %q", saved)
	}
	saved, err = store.Apply("user", "add", "Prefers short replies", "")
	if err != nil || saved != "saved user\n- Prefers short replies" {
		t.Fatalf("Apply() duplicate = %q, %v", saved, err)
	}
	saved, err = store.Apply("user", "replace", "Prefers brief replies", "short replies")
	if err != nil || saved != "saved user\n- Prefers brief replies" {
		t.Fatalf("Apply() replace = %q, %v", saved, err)
	}
	if _, err := store.Apply("memory", "add", "Editor is nvim", ""); err != nil {
		t.Fatalf("Apply() add memory error = %v", err)
	}
	user, facts, err := store.Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if user != "- Prefers brief replies" || facts != "- Editor is nvim" {
		t.Fatalf("Load() = %q, %q", user, facts)
	}
	if _, err := store.Apply("user", "remove", "", "brief"); err != nil {
		t.Fatalf("Apply() remove error = %v", err)
	}
	user, _, err = store.Load()
	if err != nil || user != "" {
		t.Fatalf("Load() after remove = %q, %v", user, err)
	}
	info, err := os.Stat(filepath.Join(store.dir, userFile))
	if err != nil {
		t.Fatalf("Stat() error = %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("USER.md mode = %o, want 600", info.Mode().Perm())
	}
}

func TestApplyRejectsAmbiguousAndFullMemory(t *testing.T) {
	store := openMemory(t)
	if _, err := store.Apply("memory", "add", "alpha project", ""); err != nil {
		t.Fatalf("Apply() error = %v", err)
	}
	if _, err := store.Apply("memory", "add", "beta project", ""); err != nil {
		t.Fatalf("Apply() error = %v", err)
	}
	if _, err := store.Apply("memory", "remove", "", "project"); err == nil || !strings.Contains(err.Error(), "more than one") {
		t.Fatalf("Apply() ambiguous error = %v", err)
	}
	if _, err := store.Apply("memory", "remove", "", "missing"); err == nil || !strings.Contains(err.Error(), "does not match") {
		t.Fatalf("Apply() missing error = %v", err)
	}
	if _, err := store.Apply("memory", "add", strings.Repeat("x", memoryLimit), ""); err == nil || !strings.Contains(err.Error(), "full") {
		t.Fatalf("Apply() full error = %v", err)
	}
}

func TestLoadMissingFiles(t *testing.T) {
	store := openMemory(t)
	user, facts, err := store.Load()
	if err != nil || user != "" || facts != "" {
		t.Fatalf("Load() = %q, %q, %v", user, facts, err)
	}
}

func openMemory(t *testing.T) *Store {
	t.Helper()
	store, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	return store
}
