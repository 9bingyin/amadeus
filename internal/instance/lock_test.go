package instance

import (
	"errors"
	"os"
	"strconv"
	"strings"
	"testing"
)

func TestAcquireRejectsASecondOwner(t *testing.T) {
	directory := t.TempDir()
	first, err := Acquire(directory)
	if err != nil {
		t.Fatalf("Acquire() error = %v", err)
	}
	t.Cleanup(func() {
		if err := first.Release(); err != nil {
			t.Errorf("Release() error = %v", err)
		}
	})

	_, err = Acquire(directory)
	if !errors.Is(err, ErrAlreadyRunning) || !strings.Contains(err.Error(), strconv.Itoa(os.Getpid())) {
		t.Fatalf("Acquire() error = %v", err)
	}

	if err := first.Release(); err != nil {
		t.Fatalf("Release() error = %v", err)
	}
	second, err := Acquire(directory)
	if err != nil {
		t.Fatalf("Acquire() after release error = %v", err)
	}
	if err := second.Release(); err != nil {
		t.Fatalf("Release() second error = %v", err)
	}
}

func TestAcquireAllowsSeparateHomes(t *testing.T) {
	first, err := Acquire(t.TempDir())
	if err != nil {
		t.Fatalf("Acquire() first error = %v", err)
	}
	t.Cleanup(func() {
		if err := first.Release(); err != nil {
			t.Errorf("Release() first error = %v", err)
		}
	})
	second, err := Acquire(t.TempDir())
	if err != nil {
		t.Fatalf("Acquire() second error = %v", err)
	}
	if err := second.Release(); err != nil {
		t.Fatalf("Release() second error = %v", err)
	}
}
