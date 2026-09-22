package schedule

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

type route struct {
	Platform  string
	AccountID string
	ChatID    string
	ThreadID  string
}

const jobColumns = `id, name, kind, spec, next_run_at_ms, state, last_status, last_error, platform, account_id, chat_id, thread_id, identity`

type job struct {
	ID        int64
	Name      string
	Identity  string
	Kind      string
	Spec      string
	Next      time.Time
	State     string
	Status    string
	LastError string
	Platform  string
	AccountID string
	ChatID    string
	ThreadID  string
}

func (j job) directory(root string) string {
	return filepath.Join(root, strconv.FormatInt(j.ID, 10))
}

func (s *Service) insert(ctx context.Context, item job) (job, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return job{}, fmt.Errorf("insert job: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	result, err := tx.ExecContext(ctx, `
		INSERT INTO jobs (
			name, kind, spec, next_run_at_ms, state, last_status, last_error,
			platform, account_id, chat_id, thread_id, created_at_ms
		) VALUES (?, ?, ?, ?, 'scheduled', '', '', ?, ?, ?, ?, ?)
	`, item.Name, item.Kind, item.Spec, item.Next.UTC().UnixMilli(),
		item.Platform, item.AccountID, item.ChatID, item.ThreadID, time.Now().UTC().UnixMilli())
	if err != nil {
		return job{}, fmt.Errorf("insert job: %w", err)
	}
	id, err := result.LastInsertId()
	if err != nil {
		return job{}, fmt.Errorf("read job id: %w", err)
	}
	item.ID = id
	item.State = "scheduled"
	item.Identity = jobIdentity(id, item.Name)
	if _, err := tx.ExecContext(ctx, `UPDATE jobs SET identity = ? WHERE id = ?`, item.Identity, item.ID); err != nil {
		return job{}, fmt.Errorf("set job identity: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return job{}, fmt.Errorf("insert job: %w", err)
	}
	return item, nil
}

func (s *Service) delete(ctx context.Context, id int64) error {
	if _, err := s.db.ExecContext(ctx, `DELETE FROM jobs WHERE id = ?`, id); err != nil {
		return fmt.Errorf("delete job %d: %w", id, err)
	}
	return nil
}

func (s *Service) list(ctx context.Context, owner route) ([]job, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT `+jobColumns+`
		FROM jobs
		WHERE platform = ? AND account_id = ? AND chat_id = ? AND thread_id = ?
		ORDER BY id
	`, owner.Platform, owner.AccountID, owner.ChatID, owner.ThreadID)
	if err != nil {
		return nil, fmt.Errorf("list jobs: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var jobs []job
	for rows.Next() {
		item, err := scanJob(rows)
		if err != nil {
			return nil, err
		}
		jobs = append(jobs, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list jobs: %w", err)
	}
	return jobs, nil
}

func (s *Service) jobByID(ctx context.Context, owner route, id int64) (job, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT `+jobColumns+`
		FROM jobs
		WHERE id = ? AND platform = ? AND account_id = ? AND chat_id = ? AND thread_id = ?
	`, id, owner.Platform, owner.AccountID, owner.ChatID, owner.ThreadID)
	item, err := scanJob(row)
	if errors.Is(err, sql.ErrNoRows) {
		return job{}, fmt.Errorf("unknown task %d", id)
	}
	if err != nil {
		return job{}, fmt.Errorf("read job %d: %w", id, err)
	}
	return item, nil
}

func (s *Service) jobsByName(ctx context.Context, owner route, name string) ([]job, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT `+jobColumns+`
		FROM jobs
		WHERE platform = ? AND account_id = ? AND chat_id = ? AND thread_id = ? AND name = ?
		ORDER BY id
	`, owner.Platform, owner.AccountID, owner.ChatID, owner.ThreadID, name)
	if err != nil {
		return nil, fmt.Errorf("find job %q: %w", name, err)
	}
	defer func() { _ = rows.Close() }()
	var jobs []job
	for rows.Next() {
		item, err := scanJob(rows)
		if err != nil {
			return nil, err
		}
		jobs = append(jobs, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("find job %q: %w", name, err)
	}
	return jobs, nil
}

func (s *Service) claim(ctx context.Context, now time.Time) (job, bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return job{}, false, fmt.Errorf("claim job: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	row := tx.QueryRowContext(ctx, `
		SELECT `+jobColumns+`
		FROM jobs
		WHERE state = 'scheduled' AND next_run_at_ms <= ?
		ORDER BY next_run_at_ms, id
		LIMIT 1
	`, now.UTC().UnixMilli())
	item, err := scanJob(row)
	if errors.Is(err, sql.ErrNoRows) {
		return job{}, false, nil
	}
	if err != nil {
		return job{}, false, fmt.Errorf("claim job: %w", err)
	}
	result, err := tx.ExecContext(ctx, `
		UPDATE jobs SET state = 'running' WHERE id = ? AND state = 'scheduled'
	`, item.ID)
	if err != nil {
		return job{}, false, fmt.Errorf("mark job %d running: %w", item.ID, err)
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return job{}, false, fmt.Errorf("mark job %d running: %w", item.ID, err)
	}
	if changed == 0 {
		return job{}, false, nil
	}
	if err := tx.Commit(); err != nil {
		return job{}, false, fmt.Errorf("claim job %d: %w", item.ID, err)
	}
	item.State = "running"
	return item, true, nil
}

func (s *Service) resumeInterrupted(ctx context.Context) error {
	if _, err := s.db.ExecContext(ctx, `UPDATE jobs SET state = 'scheduled' WHERE state = 'running'`); err != nil {
		return fmt.Errorf("resume interrupted jobs: %w", err)
	}
	return nil
}

func (s *Service) nextRun(ctx context.Context) (time.Time, bool, error) {
	var millis sql.NullInt64
	if err := s.db.QueryRowContext(ctx, `
		SELECT MIN(next_run_at_ms) FROM jobs WHERE state = 'scheduled'
	`).Scan(&millis); err != nil {
		return time.Time{}, false, fmt.Errorf("read next job time: %w", err)
	}
	if !millis.Valid {
		return time.Time{}, false, nil
	}
	return time.UnixMilli(millis.Int64).UTC(), true, nil
}

func (s *Service) finish(ctx context.Context, item job, state, status, lastError string, next time.Time) error {
	if _, err := s.db.ExecContext(ctx, `
		UPDATE jobs
		SET state = ?, last_status = ?, last_error = ?, next_run_at_ms = ?
		WHERE id = ? AND state = 'running'
	`, state, status, lastError, next.UTC().UnixMilli(), item.ID); err != nil {
		return fmt.Errorf("finish job %d: %w", item.ID, err)
	}
	return nil
}

func (s *Service) release(ctx context.Context, id int64) error {
	if _, err := s.db.ExecContext(ctx, `
		UPDATE jobs SET state = 'scheduled' WHERE id = ? AND state = 'running'
	`, id); err != nil {
		return fmt.Errorf("release job %d: %w", id, err)
	}
	return nil
}

type rowScanner interface {
	Scan(dest ...any) error
}

func scanJob(row rowScanner) (job, error) {
	var item job
	var millis int64
	if err := row.Scan(
		&item.ID, &item.Name, &item.Kind, &item.Spec, &millis, &item.State, &item.Status, &item.LastError,
		&item.Platform, &item.AccountID, &item.ChatID, &item.ThreadID, &item.Identity,
	); err != nil {
		return job{}, err
	}
	item.Next = time.UnixMilli(millis).UTC()
	return item, nil
}

func cleanName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return "", errors.New("name is required")
	}
	if utf8.RuneCountInString(name) > 200 {
		return "", errors.New("name is too long")
	}
	return name, nil
}

func writeScript(directory, script string) error {
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return fmt.Errorf("create task directory: %w", err)
	}
	path := filepath.Join(directory, "task.js")
	if err := os.WriteFile(path, []byte(script), 0o600); err != nil {
		return fmt.Errorf("write task script: %w", err)
	}
	return nil
}
