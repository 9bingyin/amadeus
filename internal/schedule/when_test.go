package schedule

import (
	"testing"
	"time"
)

func TestParseWhen(t *testing.T) {
	now := time.Date(2026, 9, 22, 8, 0, 0, 0, time.UTC)
	parsed, err := parseWhen("every 30m", now)
	if err != nil {
		t.Fatalf("parseWhen() error = %v", err)
	}
	if parsed.Kind != "every" || parsed.Spec != "30m" || parsed.Label != "every 30m" || !parsed.Next.Equal(now.Add(30*time.Minute)) {
		t.Fatalf("parseWhen() = %#v", parsed)
	}

	parsed, err = parseWhen("45m", now)
	if err != nil {
		t.Fatalf("parseWhen() error = %v", err)
	}
	if parsed.Kind != "once" || parsed.Label != "once" || !parsed.Next.Equal(now.Add(45*time.Minute)) {
		t.Fatalf("parseWhen() = %#v", parsed)
	}

	parsed, err = parseWhen("2026-09-22T15:04:05Z", now)
	if err != nil {
		t.Fatalf("parseWhen() error = %v", err)
	}
	if parsed.Kind != "once" || parsed.Spec != "2026-09-22T15:04:05Z" {
		t.Fatalf("parseWhen() = %#v", parsed)
	}

	parsed, err = parseWhen("5 4 * * *", now)
	if err != nil {
		t.Fatalf("parseWhen() error = %v", err)
	}
	if parsed.Kind != "cron" || parsed.Label != "cron 5 4 * * *" {
		t.Fatalf("parseWhen() = %#v", parsed)
	}
	if _, err := parseWhen("later", now); err == nil {
		t.Fatal("parseWhen() error = nil")
	}
}
