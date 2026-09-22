package schedule

import (
	"testing"
	"time"
)

func TestCronNext(t *testing.T) {
	location := time.FixedZone("CST", 8*60*60)
	previous := time.Local
	time.Local = location
	t.Cleanup(func() { time.Local = previous })

	expr, err := parseCron("0 9 * * *")
	if err != nil {
		t.Fatalf("parseCron() error = %v", err)
	}
	after := time.Date(2026, 9, 22, 8, 30, 0, 0, location)
	next, err := expr.next(after)
	if err != nil {
		t.Fatalf("next() error = %v", err)
	}
	want := time.Date(2026, 9, 22, 9, 0, 0, 0, location)
	if !next.Equal(want) {
		t.Fatalf("next() = %s, want %s", next, want)
	}

	expr, err = parseCron("*/15 * * * 1")
	if err != nil {
		t.Fatalf("parseCron() error = %v", err)
	}
	after = time.Date(2026, 9, 22, 9, 0, 0, 0, location)
	next, err = expr.next(after)
	if err != nil {
		t.Fatalf("next() error = %v", err)
	}
	want = time.Date(2026, 9, 28, 0, 0, 0, 0, location)
	if !next.Equal(want) {
		t.Fatalf("next() = %s, want %s", next, want)
	}
}

func TestParseCronRejectsBadFields(t *testing.T) {
	if _, err := parseCron("0 9 * *"); err == nil {
		t.Fatal("parseCron() error = nil")
	}
	if _, err := parseCron("60 * * * *"); err == nil {
		t.Fatal("parseCron() error = nil")
	}
}
