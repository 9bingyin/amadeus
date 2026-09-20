package gateway

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/9bingyin/amadeus/internal/agent"
	"github.com/9bingyin/amadeus/internal/conversation"
	"github.com/felinics/twilight/sdk"
)

type storedAgentLoop interface {
	RunStored(ctx context.Context, history []sdk.Message, conversation agent.StoredConversation) (string, error)
}

type PersistentGateway struct {
	ctx         context.Context
	cancel      context.CancelFunc
	agent       storedAgentLoop
	store       *conversation.Store
	runSpec     conversation.RunSpec
	planOutbox  conversation.OutboxPlanner
	wake        chan struct{}
	outboxReady chan struct{}

	mu          sync.Mutex
	closed      bool
	workerErr   error
	receipts    map[string]*receiptState
	runReceipts map[string]map[string]*receiptState
	worker      sync.WaitGroup
}

func NewPersistent(
	ctx context.Context,
	loop storedAgentLoop,
	store *conversation.Store,
	runSpec conversation.RunSpec,
	planOutbox conversation.OutboxPlanner,
) (*PersistentGateway, error) {
	if ctx == nil {
		return nil, errors.New("gateway context is required")
	}
	if loop == nil {
		return nil, errors.New("agent loop is required")
	}
	if store == nil {
		return nil, errors.New("conversation store is required")
	}
	if planOutbox == nil {
		return nil, errors.New("outbox planner is required")
	}
	runCtx, cancel := context.WithCancel(ctx)
	gateway := &PersistentGateway{
		ctx: runCtx, cancel: cancel, agent: loop, store: store, runSpec: runSpec, planOutbox: planOutbox,
		wake: make(chan struct{}, 1), outboxReady: make(chan struct{}, 1),
		receipts: make(map[string]*receiptState), runReceipts: make(map[string]map[string]*receiptState),
	}
	interrupted, err := store.Recover(ctx, planOutbox)
	if err != nil {
		cancel()
		return nil, fmt.Errorf("recover conversation state: %w", err)
	}
	if len(interrupted) > 0 {
		slog.WarnContext(ctx, "Interrupted unfinished agent runs", "run_ids", interrupted)
	}
	gateway.worker.Add(1)
	go gateway.processRuns()
	gateway.signal(gateway.wake)
	gateway.signal(gateway.outboxReady)
	return gateway, nil
}

func (g *PersistentGateway) Submit(ctx context.Context, message Message) (*Receipt, error) {
	started := time.Now()
	g.mu.Lock()
	if g.closed {
		err := g.closedError()
		g.mu.Unlock()
		return nil, err
	}
	g.mu.Unlock()
	if err := normalizeMessage(&message); err != nil {
		return nil, err
	}
	if err := preparePersistentMessage(&message); err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	userMessage, err := agent.BuildUserMessage(message)
	if err != nil {
		return nil, fmt.Errorf("build persisted user message: %w", err)
	}
	encoded, err := conversation.EncodeMessage(userMessage)
	if err != nil {
		return nil, fmt.Errorf("encode persisted user message: %w", err)
	}
	accepted, err := g.store.Accept(ctx, conversation.AcceptInput{
		Route: conversation.Route{
			Platform: message.Platform, AccountID: message.AccountID,
			ChatID: message.ConversationID, ThreadID: message.ThreadID,
		},
		SourceNamespace: message.SourceNamespace, SourceEventID: message.SourceEventID,
		IngressPayload: message.SourcePayload, Message: encoded, Run: g.runSpec,
	})
	if err != nil {
		return nil, fmt.Errorf("persist gateway message: %w", err)
	}
	g.signal(g.wake)

	g.mu.Lock()
	if g.closed {
		err := g.closedError()
		g.mu.Unlock()
		return nil, err
	}
	if existing := g.receipts[accepted.MessageRecordID]; existing != nil {
		g.mu.Unlock()
		return &Receipt{state: existing}, nil
	}
	outcome, err := g.store.RunOutcome(ctx, accepted.RunID)
	if err != nil {
		g.mu.Unlock()
		return nil, err
	}
	state := &receiptState{done: make(chan struct{})}
	if outcome.Status == "queued" || outcome.Status == "running" {
		g.receipts[accepted.MessageRecordID] = state
		byMessage := g.runReceipts[accepted.RunID]
		if byMessage == nil {
			byMessage = make(map[string]*receiptState)
			g.runReceipts[accepted.RunID] = byMessage
		}
		byMessage[accepted.MessageRecordID] = state
	} else {
		if !accepted.Duplicate {
			state.outcome.result.Reply = outcome.Reply
			state.outcome.err = terminalRunError(outcome)
		}
		close(state.done)
	}
	g.mu.Unlock()
	slog.InfoContext(ctx, "Persisted gateway message",
		"platform", message.Platform,
		"conversation_id", message.ConversationID,
		"thread_id", message.ThreadID,
		"run_id", accepted.RunID,
		"duplicate", accepted.Duplicate,
		"duration", time.Since(started),
	)
	return &Receipt{state: state}, nil
}

func (g *PersistentGateway) Handle(ctx context.Context, message Message) (string, error) {
	receipt, err := g.Submit(ctx, message)
	if err != nil {
		return "", err
	}
	result, err := receipt.Wait(ctx)
	if err != nil {
		return "", err
	}
	return result.Reply, nil
}

func (*PersistentGateway) UsesPersistentMessages() {}

func (g *PersistentGateway) Close() {
	g.mu.Lock()
	if !g.closed {
		g.closed = true
		g.cancel()
	}
	g.mu.Unlock()
	g.worker.Wait()
}

func (g *PersistentGateway) closedError() error {
	if g.workerErr != nil {
		return fmt.Errorf("gateway worker stopped: %w", g.workerErr)
	}
	return errors.New("gateway is closed")
}

func (g *PersistentGateway) OutboxReady() <-chan struct{} {
	return g.outboxReady
}

func (g *PersistentGateway) PendingOutbox(ctx context.Context, now time.Time) ([]conversation.PendingOutbox, error) {
	return g.store.PendingOutbox(ctx, now)
}

func (g *PersistentGateway) NextOutboxAt(ctx context.Context) (time.Time, bool, error) {
	return g.store.NextOutboxAt(ctx)
}

func (g *PersistentGateway) StartDelivery(ctx context.Context, outboxID string) (int64, error) {
	return g.store.StartDelivery(ctx, outboxID)
}

func (g *PersistentGateway) CompleteDelivery(ctx context.Context, outboxID string) error {
	err := g.store.CompleteDelivery(ctx, outboxID)
	if err == nil {
		g.signal(g.outboxReady)
	}
	return err
}

func (g *PersistentGateway) FailDelivery(
	ctx context.Context,
	outboxID, message string,
	retryAt time.Time,
	dead bool,
) error {
	err := g.store.FailDelivery(ctx, outboxID, message, retryAt, dead)
	if err == nil {
		g.signal(g.outboxReady)
	}
	return err
}

func (g *PersistentGateway) processRuns() {
	defer g.worker.Done()
	for {
		if err := g.ctx.Err(); err != nil {
			g.stopWorker(err)
			return
		}
		started, err := g.store.StartNextRun(g.ctx)
		if err != nil {
			if g.ctx.Err() != nil {
				continue
			}
			slog.ErrorContext(g.ctx, "Start persisted agent run", "err", err)
			g.stopWorker(err)
			return
		}
		if started == nil {
			select {
			case <-g.ctx.Done():
				continue
			case <-g.wake:
				continue
			}
		}
		history, err := g.store.History(g.ctx, started.ConversationID)
		reply := ""
		errorCode := "agent_error"
		if err == nil && !runSpecMatches(started, g.runSpec) {
			err = errors.New("persisted run configuration differs from the active agent configuration")
			errorCode = "configuration_changed"
		}
		if err == nil {
			stored := &storedRun{store: g.store, runID: started.ID, planOutbox: g.planOutbox}
			reply, err = g.agent.RunStored(g.ctx, history, stored)
		}
		if err != nil && g.ctx.Err() == nil {
			failErr := g.store.FailRun(g.ctx, started.ID, errorCode, err.Error(), g.planOutbox)
			if failErr != nil {
				err = errors.Join(err, failErr)
			}
		}
		g.finishRunReceipts(started.ID, reply, err)
		g.signal(g.outboxReady)
	}
}

func (g *PersistentGateway) stopWorker(err error) {
	g.mu.Lock()
	g.closed = true
	if g.workerErr == nil {
		g.workerErr = err
	}
	g.cancel()
	g.mu.Unlock()
	g.finishAll(err)
}

func (g *PersistentGateway) finishRunReceipts(runID, reply string, err error) {
	g.mu.Lock()
	receipts := g.runReceipts[runID]
	delete(g.runReceipts, runID)
	for messageID := range receipts {
		delete(g.receipts, messageID)
	}
	g.mu.Unlock()
	for _, receipt := range receipts {
		receipt.outcome = receiptOutcome{result: Result{Reply: reply}, err: err}
		close(receipt.done)
	}
}

func (g *PersistentGateway) finishAll(err error) {
	g.mu.Lock()
	receipts := g.receipts
	g.receipts = make(map[string]*receiptState)
	g.runReceipts = make(map[string]map[string]*receiptState)
	g.mu.Unlock()
	for _, receipt := range receipts {
		receipt.outcome = receiptOutcome{err: err}
		close(receipt.done)
	}
}

func (g *PersistentGateway) signal(channel chan struct{}) {
	select {
	case channel <- struct{}{}:
	default:
	}
}

type storedRun struct {
	store      *conversation.Store
	runID      string
	planOutbox conversation.OutboxPlanner
}

func (r *storedRun) BeforeRequest(ctx context.Context) ([]sdk.Message, error) {
	return r.store.CommitPending(ctx, r.runID)
}

func (r *storedRun) CommitStep(ctx context.Context, step *sdk.StepResult, final bool) (agent.StoredStep, error) {
	var planner conversation.OutboxPlanner
	if final {
		planner = r.planOutbox
	}
	committed, err := r.store.CommitStep(ctx, conversation.CommitStepInput{
		RunID: r.runID, Step: step, Final: final, PlanOutbox: planner,
	})
	if err != nil {
		return agent.StoredStep{}, err
	}
	return agent.StoredStep{NewUserMessages: committed.NewUserMessages, Sealed: committed.Sealed}, nil
}

func terminalRunError(outcome conversation.RunOutcome) error {
	if outcome.Status == "completed" {
		return nil
	}
	if outcome.ErrorMessage != "" {
		return fmt.Errorf("run %s: %s", outcome.Status, outcome.ErrorMessage)
	}
	return fmt.Errorf("run ended with status %s", outcome.Status)
}

func runSpecMatches(started *conversation.StartedRun, expected conversation.RunSpec) bool {
	return started.Provider == expected.Provider &&
		started.Model == expected.Model &&
		started.ReasoningEffort == expected.ReasoningEffort &&
		started.SystemPrompt == expected.SystemPrompt &&
		bytes.Equal(compactJSON(started.Config), compactJSON(expected.Config))
}

func compactJSON(value json.RawMessage) []byte {
	if len(value) == 0 {
		return nil
	}
	var compacted bytes.Buffer
	if err := json.Compact(&compacted, value); err != nil {
		return value
	}
	return compacted.Bytes()
}

func preparePersistentMessage(message *Message) error {
	if message.AccountID == "" {
		message.AccountID = "default"
	}
	if message.SourceNamespace == "" {
		message.SourceNamespace = message.Platform + ":" + message.AccountID
	}
	if message.SourceEventID == "" {
		var value [16]byte
		if _, err := rand.Read(value[:]); err != nil {
			return fmt.Errorf("generate message source identity: %w", err)
		}
		message.SourceEventID = "generated:" + hex.EncodeToString(value[:])
	}
	if len(message.SourcePayload) == 0 {
		payload, err := json.Marshal(struct {
			Platform       string `json:"platform"`
			ConversationID string `json:"conversationId"`
			SenderID       string `json:"senderId"`
		}{message.Platform, message.ConversationID, message.SenderID})
		if err != nil {
			return fmt.Errorf("encode generated message source: %w", err)
		}
		message.SourcePayload = payload
	}
	if !json.Valid(message.SourcePayload) {
		return errors.New("message source payload is not valid JSON")
	}
	return nil
}
