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
	controls    map[string]*runControl
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
		controls: make(map[string]*runControl),
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
	if accepted.InterruptRequested && !accepted.Duplicate {
		g.signalControl(accepted.RunID, accepted.InputRevision)
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
			if err := g.waitForRun(); err != nil && g.ctx.Err() == nil {
				slog.ErrorContext(g.ctx, "Wait for persisted agent run", "err", err)
				g.stopWorker(err)
				return
			}
			continue
		}
		control := g.control(started.ID)
		reply, err := g.runStarted(started, control)
		g.removeControl(started.ID, control)
		g.finishRunReceipts(started.ID, reply, err)
		g.signal(g.outboxReady)
	}
}

func (g *PersistentGateway) runStarted(
	started *conversation.StartedRun,
	control *runControl,
) (string, error) {
	for {
		history, err := g.store.History(g.ctx, started.ConversationID)
		errorCode := "agent_error"
		if err == nil && !runSpecMatches(started, g.runSpec) {
			err = errors.New("persisted run configuration differs from the active agent configuration")
			errorCode = "configuration_changed"
		}
		reply := ""
		if err == nil {
			stored := &storedRun{
				store: g.store, runID: started.ID, planOutbox: g.planOutbox, control: control,
			}
			reply, err = g.agent.RunStored(g.ctx, history, stored)
		}
		if err == nil || g.ctx.Err() != nil {
			return reply, err
		}
		if inputRevision, ok := agent.RequestFailureInputRevision(err); ok {
			failed, failErr := g.store.FailRunIfInputRevision(
				g.ctx, started.ID, errorCode, err.Error(), g.planOutbox, inputRevision,
			)
			if failErr != nil {
				return reply, errors.Join(err, failErr)
			}
			if !failed {
				slog.InfoContext(g.ctx, "Restarting persisted agent run after newer input",
					"run_id", started.ID,
					"input_revision", inputRevision,
				)
				continue
			}
			return reply, err
		}
		if failErr := g.store.FailRun(
			g.ctx, started.ID, errorCode, err.Error(), g.planOutbox,
		); failErr != nil {
			return reply, errors.Join(err, failErr)
		}
		return reply, err
	}
}

func (g *PersistentGateway) waitForRun() error {
	readyAt, exists, err := g.store.NextQueuedRunAt(g.ctx)
	if err != nil {
		return err
	}
	if !exists {
		select {
		case <-g.ctx.Done():
			return g.ctx.Err()
		case <-g.wake:
			return nil
		}
	}
	delay := time.Until(readyAt)
	if delay <= 0 {
		return nil
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-g.ctx.Done():
		return g.ctx.Err()
	case <-g.wake:
		return nil
	case <-timer.C:
		return nil
	}
}

func (g *PersistentGateway) control(runID string) *runControl {
	g.mu.Lock()
	defer g.mu.Unlock()
	control := g.controls[runID]
	if control == nil {
		control = newRunControl()
		g.controls[runID] = control
	}
	return control
}

func (g *PersistentGateway) signalControl(runID string, revision int64) {
	g.mu.Lock()
	control := g.controls[runID]
	g.mu.Unlock()
	if control != nil {
		control.signal(revision)
	}
}

func (g *PersistentGateway) removeControl(runID string, control *runControl) {
	g.mu.Lock()
	if g.controls[runID] == control {
		delete(g.controls, runID)
	}
	g.mu.Unlock()
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

type runControl struct {
	mu       sync.Mutex
	revision int64
	changed  chan struct{}
}

func newRunControl() *runControl {
	return &runControl{changed: make(chan struct{})}
}

func (c *runControl) acknowledge(revision int64) {
	c.mu.Lock()
	if revision > c.revision {
		c.revision = revision
	}
	c.mu.Unlock()
}

func (c *runControl) signal(revision int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if revision <= c.revision {
		return
	}
	c.revision = revision
	close(c.changed)
	c.changed = make(chan struct{})
}

func (c *runControl) watch(afterRevision int64) <-chan struct{} {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.revision > afterRevision {
		ready := make(chan struct{})
		close(ready)
		return ready
	}
	return c.changed
}

type storedRun struct {
	store      *conversation.Store
	runID      string
	planOutbox conversation.OutboxPlanner
	control    *runControl
}

func (r *storedRun) PrepareRequest(ctx context.Context) (agent.StoredInput, error) {
	for {
		prepared, err := r.store.PrepareInput(ctx, r.runID)
		if err != nil {
			return agent.StoredInput{}, err
		}
		if prepared.Ready {
			r.control.acknowledge(prepared.InputRevision)
			return agent.StoredInput{
				Messages: prepared.Messages, InputRevision: prepared.InputRevision,
			}, nil
		}
		delay := time.Until(prepared.ReadyAt)
		if delay <= 0 {
			continue
		}
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return agent.StoredInput{}, ctx.Err()
		case <-timer.C:
		}
	}
}

func (r *storedRun) WatchInput(afterRevision int64) <-chan struct{} {
	return r.control.watch(afterRevision)
}

func (r *storedRun) InputCurrent(ctx context.Context, inputRevision int64) (bool, error) {
	return r.store.InputCurrent(ctx, r.runID, inputRevision)
}

func (r *storedRun) AdmitResponse(
	ctx context.Context,
	requestSequence, inputRevision int64,
) (bool, error) {
	return r.store.AdmitResponse(ctx, r.runID, requestSequence, inputRevision)
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
	return agent.StoredStep{Sealed: committed.Sealed}, nil
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
