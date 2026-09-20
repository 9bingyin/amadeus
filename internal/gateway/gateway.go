package gateway

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/9bingyin/amadeus/internal/agent"
)

type Message = agent.Message
type Attachment = agent.Attachment
type AttachmentKind = agent.AttachmentKind

const (
	AttachmentKindImage = agent.AttachmentKindImage
	AttachmentKindFile  = agent.AttachmentKindFile
)

type Handler interface {
	Handle(ctx context.Context, message Message) (string, error)
}

type HandlerFunc func(ctx context.Context, message Message) (string, error)

func (f HandlerFunc) Handle(ctx context.Context, message Message) (string, error) {
	return f(ctx, message)
}

type Gateway struct {
	agent agentLoop
	turn  chan struct{}
}

type agentLoop interface {
	Run(ctx context.Context, message Message) (string, error)
}

func New(loop agentLoop) (*Gateway, error) {
	if loop == nil {
		return nil, errors.New("agent loop is required")
	}
	return &Gateway{agent: loop, turn: make(chan struct{}, 1)}, nil
}

func (g *Gateway) Handle(ctx context.Context, message Message) (string, error) {
	started := time.Now()
	slog.DebugContext(ctx, "Received gateway message", "message", message)
	message.Platform = strings.TrimSpace(message.Platform)
	message.ConversationID = strings.TrimSpace(message.ConversationID)
	message.SenderID = strings.TrimSpace(message.SenderID)
	message.Text = strings.TrimSpace(message.Text)
	if message.Platform == "" {
		return "", errors.New("message platform is required")
	}
	if message.ConversationID == "" {
		return "", errors.New("message conversation ID is required")
	}
	if message.SenderID == "" {
		return "", errors.New("message sender ID is required")
	}
	if message.Text == "" && len(message.Attachments) == 0 {
		return "", errors.New("message text or attachment is required")
	}

	if err := ctx.Err(); err != nil {
		slog.DebugContext(ctx, "Gateway message canceled", "message", message, "err", err)
		return "", err
	}
	waitStarted := time.Now()
	select {
	case g.turn <- struct{}{}:
		defer func() { <-g.turn }()
	case <-ctx.Done():
		slog.DebugContext(ctx, "Gateway wait canceled", "message", message, "duration", time.Since(started), "err", ctx.Err())
		return "", ctx.Err()
	}
	queueDuration := time.Since(waitStarted)
	if err := ctx.Err(); err != nil {
		slog.DebugContext(ctx, "Gateway message canceled", "message", message, "duration", time.Since(started), "err", err)
		return "", err
	}

	reply, err := g.agent.Run(ctx, message)
	if err != nil {
		attributes := []any{
			"platform", message.Platform,
			"conversation_id", message.ConversationID,
			"sender_id", message.SenderID,
			"queue_duration", queueDuration,
			"duration", time.Since(started),
			"err", err,
		}
		if ctx.Err() != nil {
			slog.DebugContext(ctx, "Gateway message canceled", attributes...)
		} else {
			slog.ErrorContext(ctx, "Handle gateway message", attributes...)
		}
		return "", fmt.Errorf("run agent loop: %w", err)
	}
	slog.DebugContext(ctx, "Completed gateway message", "message", message, "reply", reply)
	slog.InfoContext(ctx, "Handled gateway message",
		"platform", message.Platform,
		"conversation_id", message.ConversationID,
		"sender_id", message.SenderID,
		"queue_duration", queueDuration,
		"duration", time.Since(started),
	)
	return reply, nil
}
