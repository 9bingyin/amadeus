package gateway

import (
	"context"
	"log/slog"

	"github.com/9bingyin/amadeus/internal/memory"
)

type memoryRewriter interface {
	RewriteMemory(ctx context.Context, target, text string, limit int) (string, error)
}

func (g *PersistentGateway) EnableDream(memories *memory.Store) {
	if memories == nil {
		return
	}
	rewriter, ok := g.agent.(memoryRewriter)
	if !ok || rewriter == nil {
		return
	}
	g.mu.Lock()
	if g.closed || g.memories != nil {
		g.mu.Unlock()
		return
	}
	g.memories = memories
	g.dreamer = rewriter
	g.mu.Unlock()
	g.worker.Add(1)
	go g.dreamMemories()
	g.signal(g.dreamWake)
}

func (g *PersistentGateway) dreamMemories() {
	defer g.worker.Done()
	memories := g.memories
	rewriter := g.dreamer
	for {
		if g.ctx.Err() != nil {
			return
		}
		if err := g.sweepDream(memories, rewriter); err != nil && g.ctx.Err() == nil {
			slog.ErrorContext(g.ctx, "Dream memory failed", "err", err)
		}
		select {
		case <-g.ctx.Done():
			return
		case <-g.dreamWake:
		}
	}
}

func (g *PersistentGateway) sweepDream(memories *memory.Store, rewriter memoryRewriter) error {
	for {
		if err := g.ctx.Err(); err != nil {
			return err
		}
		busy, err := g.store.HasOpenRun(g.ctx)
		if err != nil {
			return err
		}
		if busy {
			return nil
		}
		candidate, ok, err := memories.NextDream()
		if err != nil || !ok {
			return err
		}
		replacement, err := rewriter.RewriteMemory(g.ctx, candidate.Target, candidate.Text, candidate.Limit)
		if g.ctx.Err() != nil {
			return g.ctx.Err()
		}
		busy, busyErr := g.store.HasOpenRun(g.ctx)
		if busyErr != nil {
			return busyErr
		}
		if busy {
			return nil
		}
		if err != nil {
			slog.ErrorContext(g.ctx, "Rewrite memory failed", "target", candidate.Target, "err", err)
			if skipErr := memories.SkipDream(candidate.Target, candidate.Text); skipErr != nil {
				return skipErr
			}
			continue
		}
		applied, err := memories.AcceptDream(candidate.Target, candidate.Text, replacement)
		if err != nil {
			return err
		}
		if applied {
			slog.InfoContext(g.ctx, "Shortened memory", "target", candidate.Target)
		}
	}
}
