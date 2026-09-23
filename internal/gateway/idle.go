package gateway

import (
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/9bingyin/amadeus/internal/agent"
	"github.com/9bingyin/amadeus/internal/conversation"
)

const idleCommandNamespace = "idle"

func (g *PersistentGateway) EnableIdleCompaction(after time.Duration, excludedSourceNamespace string) {
	if after <= 0 || excludedSourceNamespace == "" || g.compactor == nil {
		return
	}
	g.mu.Lock()
	if g.closed || g.idleAfter > 0 {
		g.mu.Unlock()
		return
	}
	g.idleAfter = after
	g.idleExcludedSource = excludedSourceNamespace
	g.mu.Unlock()
	g.worker.Add(1)
	go g.compactIdleConversations()
}

func (g *PersistentGateway) compactIdleConversations() {
	defer g.worker.Done()
	for {
		if g.ctx.Err() != nil {
			return
		}
		wait := g.sweepIdle()
		timer := time.NewTimer(wait)
		select {
		case <-g.ctx.Done():
			timer.Stop()
			return
		case <-g.idleWake:
			timer.Stop()
		case <-timer.C:
		}
	}
}

func (g *PersistentGateway) sweepIdle() time.Duration {
	rows, err := g.store.ListConversationUserActivity(g.ctx, g.idleExcludedSource)
	if err != nil {
		if g.ctx.Err() == nil {
			slog.ErrorContext(g.ctx, "List idle conversations failed", "err", err)
		}
		return time.Minute
	}
	now := time.Now()
	wait := g.idleAfter
	for _, row := range rows {
		due := row.LastUserAt.Add(g.idleAfter)
		if row.Busy || due.After(now) {
			remaining := due.Sub(now)
			if row.Busy && remaining < time.Second {
				remaining = time.Second
			}
			if remaining > 0 && remaining < wait {
				wait = remaining
			}
			continue
		}
		switch g.compactIdleConversation(row) {
		case idleRetry:
			return time.Second
		case idleDone:
			return 0
		}
	}
	if wait <= 0 {
		return time.Second
	}
	return wait
}

type idleResult int

const (
	idleSkipped idleResult = iota
	idleDone
	idleRetry
)

func (g *PersistentGateway) compactIdleConversation(row conversation.ConversationActivity) idleResult {
	command := conversation.ContextCommand{
		Route:           row.Route,
		SourceNamespace: idleCommandNamespace,
		SourceEventID:   fmt.Sprintf("%s:%d", row.ID, row.LastUserAt.UnixMilli()),
	}
	_, completed, err := g.store.ContextCommandResult(g.ctx, command)
	if err != nil {
		if g.ctx.Err() == nil {
			slog.ErrorContext(g.ctx, "Look up idle compaction failed", "conversation_id", row.ID, "err", err)
		}
		return idleRetry
	}
	if completed {
		return idleSkipped
	}
	conversationID, snapshot, err := g.store.ContextByRoute(g.ctx, row.Route)
	if errors.Is(err, conversation.ErrConversationMissing) {
		return idleSkipped
	}
	if err != nil {
		if g.ctx.Err() == nil {
			slog.ErrorContext(g.ctx, "Load idle conversation failed", "conversation_id", row.ID, "err", err)
		}
		return idleRetry
	}
	compaction, err := g.compactor.CompactContext(g.ctx, snapshot.Messages)
	if errors.Is(err, agent.ErrContextNotCompactable) {
		if completeErr := g.store.CompleteContextCommand(
			g.ctx, command, "compact", conversation.CommandResultNotCompactable, conversationID, nil,
		); completeErr != nil {
			slog.ErrorContext(g.ctx, "Record idle compaction skipped", "conversation_id", row.ID, "err", completeErr)
			return idleRetry
		}
		return idleDone
	}
	if err != nil {
		if g.ctx.Err() != nil {
			return idleSkipped
		}
		slog.ErrorContext(g.ctx, "Idle context compaction failed", "conversation_id", row.ID, "err", err)
		if completeErr := g.store.CompleteContextCommand(
			g.ctx, command, "compact", conversation.CommandResultFailed, conversationID, nil,
		); completeErr != nil {
			slog.ErrorContext(g.ctx, "Record idle compaction failure", "conversation_id", row.ID, "err", completeErr)
			return idleRetry
		}
		return idleDone
	}
	usage := compaction.SummaryUsage
	committed, err := g.store.CommitManualContextCheckpoint(g.ctx, conversation.CommitManualContextCheckpointInput{
		ContextCommand: command, Cause: "idle", ConversationID: conversationID,
		ParentRecordID:          snapshot.CheckpointRecordID,
		SourceHistoryThroughSeq: snapshot.HistoryThroughSeq,
		Replacement:             compaction.Replacement,
		SummaryModel:            compaction.SummaryModel,
		SummaryPromptVersion:    compaction.SummaryPromptVersion, SummaryUsage: &usage,
		EstimatedTokensBefore: compaction.EstimatedTokensBefore,
		EstimatedTokensAfter:  compaction.EstimatedTokensAfter,
	})
	if errors.Is(err, conversation.ErrConversationBusy) || g.ctx.Err() != nil {
		return idleRetry
	}
	if err != nil {
		slog.ErrorContext(g.ctx, "Commit idle compaction failed", "conversation_id", row.ID, "err", err)
		return idleRetry
	}
	if !committed.Applied {
		return idleRetry
	}
	slog.InfoContext(g.ctx, "Compacted idle conversation", "conversation_id", row.ID)
	return idleDone
}
