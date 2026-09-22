package gateway

import (
	"context"
	"encoding/json"
	"errors"

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

// Submitter accepts a message without waiting for the agent or delivery. The
// returned receipt resolves when the run containing the message finishes.
type Submitter interface {
	Submit(ctx context.Context, message Message) (*Receipt, error)
}

type EmbeddingPhase string

const (
	EmbeddingIdle       EmbeddingPhase = "idle"
	EmbeddingIndexing   EmbeddingPhase = "indexing"
	EmbeddingWaiting    EmbeddingPhase = "waiting"
	EmbeddingRebuilding EmbeddingPhase = "rebuilding"
)

type EmbeddingProgress struct {
	Done  int
	Total int
	Phase EmbeddingPhase
}

type ConversationStatus struct {
	SessionID              string
	Provider               string
	Model                  string
	ReasoningEffort        string
	EstimatedContextTokens int
	ContextWindowTokens    int
	InputTokens            int
	CachedInputTokens      int
	Embedding              *EmbeddingProgress
}

type ConversationReference struct {
	Platform        string
	AccountID       string
	ConversationID  string
	ThreadID        string
	SourceNamespace string
	SourceEventID   string
	SourcePayload   json.RawMessage
	SuccessReply    string
	EmptyReply      string
	FormatStatus    func(ConversationStatus) string
}

type ConversationCommander interface {
	NewConversation(ctx context.Context, reference ConversationReference) error
	CompactConversation(ctx context.Context, reference ConversationReference) error
	StatusConversation(ctx context.Context, reference ConversationReference) error
}

var (
	ErrConversationMissing        = errors.New("conversation does not exist")
	ErrConversationNotCompactable = errors.New("conversation cannot be compacted")
)

type Result struct {
	Reply   string
	Deliver bool
}

type receiptOutcome struct {
	result Result
	err    error
}

type receiptState struct {
	done    chan struct{}
	outcome receiptOutcome
}

type Receipt struct {
	state *receiptState
}

func (r *Receipt) Wait(ctx context.Context) (Result, error) {
	if r == nil || r.state == nil {
		return Result{}, errors.New("gateway receipt is required")
	}
	select {
	case <-r.state.done:
		return r.state.outcome.result, r.state.outcome.err
	case <-ctx.Done():
		return Result{}, ctx.Err()
	}
}
