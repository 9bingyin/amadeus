package agent

import (
	"context"
	"sync/atomic"
)

type ToolActivity struct {
	RunID         string
	Platform      string
	ChatID        string
	ThreadID      string
	Name          string
	Input         any
	InputRevision int64
}

type CompactionActivity struct {
	RunID    string
	Platform string
	ChatID   string
	ThreadID string
}

type ToolObserver interface {
	ToolStarted(ctx context.Context, activity ToolActivity)
	ToolProgressReset(ctx context.Context, activity ToolActivity)
	CompactionStarted(ctx context.Context, activity CompactionActivity)
	CompactionFinished(ctx context.Context, activity CompactionActivity)
}

type ToolRun struct {
	ID               string
	Platform         string
	ChatID           string
	ThreadID         string
	Notify           func(context.Context, ToolActivity)
	ResetProgress    func(context.Context, ToolActivity)
	NotifyCompaction func(context.Context, CompactionActivity, bool)
}

type toolRunKey struct{}

type inputRevisionKey struct{}

func WithToolRun(ctx context.Context, run ToolRun) context.Context {
	return context.WithValue(ctx, toolRunKey{}, run)
}

func withInputRevision(ctx context.Context) context.Context {
	if ctx == nil {
		ctx = context.Background()
	}
	return context.WithValue(ctx, inputRevisionKey{}, &atomic.Int64{})
}

func noteInputRevision(ctx context.Context, revision int64) bool {
	box, ok := ctx.Value(inputRevisionKey{}).(*atomic.Int64)
	if !ok || box == nil {
		return false
	}
	previous := box.Swap(revision)
	return previous != 0 && previous != revision
}

func inputRevision(ctx context.Context) int64 {
	box, ok := ctx.Value(inputRevisionKey{}).(*atomic.Int64)
	if !ok || box == nil {
		return 0
	}
	return box.Load()
}

func notifyProgressReset(ctx context.Context, revision int64) {
	if ctx == nil || revision == 0 {
		return
	}
	run, ok := ctx.Value(toolRunKey{}).(ToolRun)
	if !ok || run.ResetProgress == nil {
		return
	}
	run.ResetProgress(ctx, ToolActivity{
		RunID: run.ID, Platform: run.Platform, ChatID: run.ChatID, ThreadID: run.ThreadID,
		InputRevision: revision,
	})
}

func beginCompaction(ctx context.Context) func() {
	if ctx == nil {
		return func() {}
	}
	run, ok := ctx.Value(toolRunKey{}).(ToolRun)
	if !ok || run.NotifyCompaction == nil {
		return func() {}
	}
	activity := CompactionActivity{
		RunID: run.ID, Platform: run.Platform, ChatID: run.ChatID, ThreadID: run.ThreadID,
	}
	run.NotifyCompaction(ctx, activity, true)
	return func() {
		run.NotifyCompaction(context.WithoutCancel(ctx), activity, false)
	}
}
