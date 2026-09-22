package gateway

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/9bingyin/amadeus/internal/agent"
)

type Gateway struct {
	ctx        context.Context
	cancel     context.CancelFunc
	agent      agentLoop
	continuous continuousAgentLoop

	mu         sync.Mutex
	openRuns   map[string]*agentRun
	queue      []*agentRun
	processing bool
	closed     bool
	workers    sync.WaitGroup
}

type agentLoop interface {
	Run(ctx context.Context, message Message) (string, error)
}

type continuousAgentLoop interface {
	RunConversation(ctx context.Context, messages []Message, inbox agent.Inbox) (string, error)
}

type submission struct {
	message Message
	receipt *receiptState
}

type agentRun struct {
	gateway    *Gateway
	key        string
	ctx        context.Context
	requestCtx context.Context
	accepting  bool
	pending    []*submission
	consumed   []*submission
}

func New(ctx context.Context, loop agentLoop) (*Gateway, error) {
	if ctx == nil {
		return nil, errors.New("gateway context is required")
	}
	if loop == nil {
		return nil, errors.New("agent loop is required")
	}
	runCtx, cancel := context.WithCancel(ctx)
	gateway := &Gateway{
		ctx:      runCtx,
		cancel:   cancel,
		agent:    loop,
		openRuns: make(map[string]*agentRun),
	}
	gateway.continuous, _ = loop.(continuousAgentLoop)
	return gateway, nil
}

// Submit validates and enqueues a message. When continuous execution is
// supported, messages for the same conversation join its open queued or
// running run. Calls never wait for another run to finish.
func (g *Gateway) Submit(ctx context.Context, message Message) (*Receipt, error) {
	started := time.Now()
	slog.DebugContext(ctx, "Received gateway message", "message", message)
	if err := normalizeMessage(&message); err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		slog.DebugContext(ctx, "Gateway message canceled", "message", message, "err", err)
		return nil, err
	}

	item := &submission{
		message: message,
		receipt: &receiptState{done: make(chan struct{})},
	}
	key := conversationKey(message)

	g.mu.Lock()
	if g.closed {
		g.mu.Unlock()
		return nil, errors.New("gateway is closed")
	}
	if g.continuous != nil {
		if run := g.openRuns[key]; run != nil && run.accepting {
			run.pending = append(run.pending, item)
			g.mu.Unlock()
			slog.InfoContext(ctx, "Joined active agent run",
				"platform", message.Platform,
				"conversation_id", message.ConversationID,
				"sender_id", message.SenderID,
				"duration", time.Since(started),
			)
			return &Receipt{state: item.receipt}, nil
		}
	}

	run := &agentRun{
		gateway:    g,
		key:        key,
		ctx:        g.ctx,
		requestCtx: ctx,
		accepting:  g.continuous != nil,
		pending:    []*submission{item},
	}
	if run.accepting {
		g.openRuns[key] = run
	}
	g.queue = append(g.queue, run)
	if !g.processing {
		g.processing = true
		g.workers.Add(1)
		go g.processQueue()
	}
	g.mu.Unlock()

	slog.InfoContext(ctx, "Queued agent run",
		"platform", message.Platform,
		"conversation_id", message.ConversationID,
		"sender_id", message.SenderID,
		"duration", time.Since(started),
	)
	return &Receipt{state: item.receipt}, nil
}

func (g *Gateway) Handle(ctx context.Context, message Message) (string, error) {
	started := time.Now()
	receipt, err := g.Submit(ctx, message)
	if err != nil {
		return "", err
	}
	result, err := receipt.Wait(ctx)
	if err != nil {
		attributes := []any{
			"platform", message.Platform,
			"conversation_id", message.ConversationID,
			"sender_id", message.SenderID,
			"duration", time.Since(started),
			"err", err,
		}
		if ctx.Err() != nil {
			slog.DebugContext(ctx, "Gateway message canceled", attributes...)
		} else {
			slog.ErrorContext(ctx, "Handle gateway message", attributes...)
		}
		return "", err
	}
	if !result.Deliver {
		return "", nil
	}
	slog.DebugContext(ctx, "Completed gateway message", "message", message, "reply", result.Reply)
	slog.InfoContext(ctx, "Handled gateway message",
		"platform", message.Platform,
		"conversation_id", message.ConversationID,
		"sender_id", message.SenderID,
		"duration", time.Since(started),
	)
	return result.Reply, nil
}

func normalizeMessage(message *Message) error {
	message.Platform = strings.TrimSpace(message.Platform)
	message.ConversationID = strings.TrimSpace(message.ConversationID)
	message.SenderID = strings.TrimSpace(message.SenderID)
	message.Text = strings.TrimSpace(message.Text)
	if message.Platform == "" {
		return errors.New("message platform is required")
	}
	if message.ConversationID == "" {
		return errors.New("message conversation ID is required")
	}
	if message.SenderID == "" {
		return errors.New("message sender ID is required")
	}
	if message.Text == "" && len(message.Attachments) == 0 {
		return errors.New("message text or attachment is required")
	}
	return nil
}

func conversationKey(message Message) string {
	return message.Platform + "\x00" + message.ConversationID
}

func (g *Gateway) Close() {
	g.mu.Lock()
	if !g.closed {
		g.closed = true
		g.cancel()
	}
	g.mu.Unlock()
	g.workers.Wait()
}

func (g *Gateway) processQueue() {
	defer g.workers.Done()
	for {
		g.mu.Lock()
		if len(g.queue) == 0 {
			g.processing = false
			g.mu.Unlock()
			return
		}
		run := g.queue[0]
		g.queue = g.queue[1:]
		initial := run.drainLocked()
		g.mu.Unlock()

		var reply string
		var err error
		if contextErr := run.ctx.Err(); contextErr != nil {
			err = contextErr
		} else if g.continuous == nil && run.requestCtx.Err() != nil {
			err = run.requestCtx.Err()
		} else if g.continuous != nil {
			reply, err = g.continuous.RunConversation(run.ctx, initial, run)
		} else {
			requestCtx, cancelRequest := context.WithCancel(run.ctx)
			stopRequestCancel := context.AfterFunc(run.requestCtx, cancelRequest)
			reply, err = g.agent.Run(requestCtx, initial[0])
			stopRequestCancel()
			cancelRequest()
		}
		if err != nil {
			err = fmt.Errorf("run agent loop: %w", err)
		}
		g.finishRun(run, reply, err)
	}
}

func (g *Gateway) finishRun(run *agentRun, reply string, err error) {
	g.mu.Lock()
	if current := g.openRuns[run.key]; current == run {
		delete(g.openRuns, run.key)
	}
	run.accepting = false
	submissions := append(run.consumed, run.pending...)
	run.consumed = nil
	run.pending = nil
	g.mu.Unlock()

	for index, submission := range submissions {
		submission.receipt.outcome = receiptOutcome{
			result: Result{Reply: reply, Deliver: index == len(submissions)-1},
			err:    err,
		}
		close(submission.receipt.done)
	}
}

func (r *agentRun) Drain() []Message {
	r.gateway.mu.Lock()
	defer r.gateway.mu.Unlock()
	return r.drainLocked()
}

func (r *agentRun) DrainOrSeal() ([]Message, bool) {
	r.gateway.mu.Lock()
	defer r.gateway.mu.Unlock()
	if len(r.pending) > 0 {
		return r.drainLocked(), false
	}
	r.accepting = false
	if current := r.gateway.openRuns[r.key]; current == r {
		delete(r.gateway.openRuns, r.key)
	}
	return nil, true
}

func (r *agentRun) drainLocked() []Message {
	if len(r.pending) == 0 {
		return nil
	}
	pending := r.pending
	r.pending = nil
	r.consumed = append(r.consumed, pending...)
	messages := make([]Message, len(pending))
	for index, submission := range pending {
		messages[index] = submission.message
	}
	return messages
}
