package schedule

import (
	"fmt"
	"strings"
	"time"
	"unicode"
)

type parsedWhen struct {
	Kind  string
	Spec  string
	Next  time.Time
	Label string
}

func parseWhen(when string, now time.Time) (parsedWhen, error) {
	when = strings.TrimSpace(when)
	if when == "" {
		return parsedWhen{}, fmt.Errorf("when is required")
	}
	if spec, ok := cutEvery(when); ok {
		interval, err := time.ParseDuration(spec)
		if err != nil || interval <= 0 {
			return parsedWhen{}, fmt.Errorf("parse interval %q", spec)
		}
		return parsedWhen{Kind: "every", Spec: spec, Next: now.Add(interval), Label: "every " + spec}, nil
	}
	if len(strings.Fields(when)) == 5 {
		spec, err := normalizeCron(when)
		if err != nil {
			return parsedWhen{}, err
		}
		expr, err := parseCron(spec)
		if err != nil {
			return parsedWhen{}, err
		}
		next, err := expr.next(now)
		if err != nil {
			return parsedWhen{}, err
		}
		return parsedWhen{Kind: "cron", Spec: spec, Next: next, Label: "cron " + spec}, nil
	}
	if instant, err := time.Parse(time.RFC3339, when); err == nil {
		return parsedWhen{Kind: "once", Spec: instant.UTC().Format(time.RFC3339), Next: instant, Label: "once"}, nil
	}
	interval, err := time.ParseDuration(when)
	if err != nil || interval <= 0 {
		return parsedWhen{}, fmt.Errorf("parse schedule %q", when)
	}
	return parsedWhen{Kind: "once", Spec: strings.TrimSpace(when), Next: now.Add(interval), Label: "once"}, nil
}

func cutEvery(when string) (string, bool) {
	const prefix = "every"
	if len(when) <= len(prefix) || !strings.EqualFold(when[:len(prefix)], prefix) {
		return "", false
	}
	rest := when[len(prefix):]
	if rest == "" || !unicode.IsSpace(rune(rest[0])) {
		return "", false
	}
	spec := strings.TrimSpace(rest)
	if spec == "" {
		return "", false
	}
	return spec, true
}

func (p parsedWhen) nextAfter(now time.Time) (time.Time, error) {
	switch p.Kind {
	case "every":
		interval, err := time.ParseDuration(p.Spec)
		if err != nil || interval <= 0 {
			return time.Time{}, fmt.Errorf("parse interval %q", p.Spec)
		}
		return now.Add(interval), nil
	case "cron":
		expr, err := parseCron(p.Spec)
		if err != nil {
			return time.Time{}, err
		}
		return expr.next(now)
	default:
		return time.Time{}, fmt.Errorf("schedule kind %q does not repeat", p.Kind)
	}
}

func labelFor(kind, spec string) string {
	switch kind {
	case "every":
		return "every " + spec
	case "cron":
		return "cron " + spec
	default:
		return "once"
	}
}
