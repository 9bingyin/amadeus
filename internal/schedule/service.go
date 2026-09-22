package schedule

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/9bingyin/amadeus/internal/platform/local"
)

const errorRetryDelay = time.Minute

type Runner struct {
	Platform *local.Platform
	Agent    func(context.Context, string, string, func(string) error) (string, error)
}

type Service struct {
	db        *sql.DB
	directory string
	wake      chan struct{}
	runnerMu  sync.RWMutex
	runner    Runner
}

func Open(db *sql.DB, directory string) (*Service, error) {
	if db == nil {
		return nil, errors.New("state database is required")
	}
	directory = strings.TrimSpace(directory)
	if directory == "" {
		return nil, errors.New("jobs directory is required")
	}
	absolute, err := filepath.Abs(directory)
	if err != nil {
		return nil, fmt.Errorf("resolve jobs directory: %w", err)
	}
	if err := os.MkdirAll(absolute, 0o700); err != nil {
		return nil, fmt.Errorf("create jobs directory: %w", err)
	}
	return &Service{db: db, directory: absolute, wake: make(chan struct{}, 1)}, nil
}

func (s *Service) Use(runner Runner) {
	s.runnerMu.Lock()
	s.runner = runner
	s.runnerMu.Unlock()
}

func (s *Service) currentRunner() Runner {
	s.runnerMu.RLock()
	defer s.runnerMu.RUnlock()
	return s.runner
}

func (s *Service) Run(ctx context.Context) {
	if err := s.resumeInterrupted(ctx); err != nil {
		slog.ErrorContext(ctx, "Resume interrupted jobs", "err", err)
	}
	for {
		if err := ctx.Err(); err != nil {
			return
		}
		if err := s.runDue(ctx); err != nil && ctx.Err() == nil {
			slog.ErrorContext(ctx, "Run scheduled jobs", "err", err)
		}
		if err := ctx.Err(); err != nil {
			return
		}
		wait, err := s.wait(ctx)
		if err != nil {
			slog.ErrorContext(ctx, "Read next scheduled job", "err", err)
			wait = errorRetryDelay
		}
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-s.wake:
			timer.Stop()
		case <-timer.C:
		}
	}
}

func (s *Service) wait(ctx context.Context) (time.Duration, error) {
	next, ok, err := s.nextRun(ctx)
	if err != nil || !ok {
		if err != nil {
			return 0, err
		}
		return 24 * time.Hour, nil
	}
	delay := time.Until(next)
	if delay < 0 {
		return 0, nil
	}
	return delay, nil
}

func (s *Service) runDue(ctx context.Context) error {
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		item, ok, err := s.claim(ctx, time.Now())
		if err != nil {
			return err
		}
		if !ok {
			return nil
		}
		s.execute(ctx, item)
	}
}

func (s *Service) execute(ctx context.Context, item job) {
	slog.InfoContext(ctx, "Running scheduled task", "id", item.ID, "name", item.Name)
	persist := context.WithoutCancel(ctx)
	if err := ctx.Err(); err != nil {
		if releaseErr := s.release(persist, item.ID); releaseErr != nil {
			slog.ErrorContext(ctx, "Release scheduled task", "id", item.ID, "err", releaseErr)
		}
		return
	}
	notes := &notifications{}
	err := s.run(ctx, item, notes)
	if err != nil {
		if ctx.Err() != nil {
			if releaseErr := s.release(persist, item.ID); releaseErr != nil {
				slog.ErrorContext(ctx, "Release scheduled task", "id", item.ID, "err", releaseErr)
			}
			return
		}
		slog.ErrorContext(ctx, "Scheduled task failed", "id", item.ID, "name", item.Name, "err", err)
		if finishErr := s.fail(persist, item, err); finishErr != nil {
			slog.ErrorContext(ctx, "Record scheduled task failure", "id", item.ID, "err", finishErr)
		}
		s.wakeSoon()
		return
	}
	if err := s.deliver(ctx, item, notes.texts); err != nil {
		if ctx.Err() != nil {
			if releaseErr := s.release(persist, item.ID); releaseErr != nil {
				slog.ErrorContext(ctx, "Release scheduled task", "id", item.ID, "err", releaseErr)
			}
			return
		}
		slog.ErrorContext(ctx, "Deliver scheduled task", "id", item.ID, "err", err)
		if finishErr := s.fail(persist, item, err); finishErr != nil {
			slog.ErrorContext(ctx, "Record scheduled task failure", "id", item.ID, "err", finishErr)
		}
		s.wakeSoon()
		return
	}
	if err := s.succeed(persist, item, len(notes.texts) > 0); err != nil {
		slog.ErrorContext(ctx, "Record scheduled task result", "id", item.ID, "err", err)
	}
}

func (s *Service) run(ctx context.Context, item job, notes *notifications) error {
	scriptPath := filepath.Join(item.directory(s.directory), "task.js")
	script, err := os.ReadFile(scriptPath)
	if err != nil {
		return fmt.Errorf("read task script: %w", err)
	}
	root, err := os.OpenRoot(item.directory(s.directory))
	if err != nil {
		return fmt.Errorf("open task directory: %w", err)
	}
	defer func() { _ = root.Close() }()
	runner := s.currentRunner()
	return runScript(ctx, string(script), scriptHost{
		agent: func(ctx context.Context, prompt string) (string, error) {
			if runner.Agent == nil {
				return "", errors.New("agent is unavailable")
			}
			reply, err := runner.Agent(ctx, item.directory(s.directory), prompt, notes.add)
			if err != nil {
				return "", err
			}
			return reply, nil
		},
		post: notes.add,
		root: root,
	})
}

func (s *Service) deliver(ctx context.Context, item job, texts []string) error {
	runner := s.currentRunner()
	if len(texts) == 0 {
		return nil
	}
	if runner.Platform == nil {
		return errors.New("local platform is unavailable")
	}
	for index, text := range texts {
		err := runner.Platform.Post(ctx, local.Message{
			Route: local.Route{
				Platform: item.Platform, AccountID: item.AccountID, ChatID: item.ChatID, ThreadID: item.ThreadID,
			},
			Identity: item.Identity,
			Detail:   labelFor(item.Kind, item.Spec),
			Text:     text,
			EventID:  fmt.Sprintf("%d-%d-%d", item.ID, time.Now().UnixNano(), index),
		})
		if err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) succeed(ctx context.Context, item job, notified bool) error {
	status := "silent"
	if notified {
		status = "ok"
	}
	now := time.Now()
	if item.Kind == "once" {
		return s.finish(ctx, item, "completed", status, "", item.Next)
	}
	next, err := parsedWhen{Kind: item.Kind, Spec: item.Spec}.nextAfter(now)
	if err != nil {
		return s.fail(ctx, item, err)
	}
	return s.finish(ctx, item, "scheduled", status, "", next)
}

func (s *Service) fail(ctx context.Context, item job, cause error) error {
	return s.finish(ctx, item, "scheduled", "error", cause.Error(), time.Now().Add(errorRetryDelay))
}

func (s *Service) wakeSoon() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

type notifications struct {
	mu    sync.Mutex
	texts []string
}

func (n *notifications) add(text string) error {
	text = strings.TrimSpace(text)
	if text == "" {
		return errors.New("text is required")
	}
	n.mu.Lock()
	n.texts = append(n.texts, text)
	n.mu.Unlock()
	return nil
}
