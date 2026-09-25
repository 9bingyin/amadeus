package conversation

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"time"
)

const (
	RecordSchemaVersion  = 1
	MessageSchemaVersion = 1
)

type RecordKind string

const (
	RecordKindConversationCreated RecordKind = "conversation.created"
	RecordKindSessionStarted      RecordKind = "session.started"
	RecordKindIngressReceived     RecordKind = "ingress.received"
	RecordKindRunCreated          RecordKind = "run.created"
	RecordKindRunStarted          RecordKind = "run.started"
	RecordKindRunCompleted        RecordKind = "run.completed"
	RecordKindRunFailed           RecordKind = "run.failed"
	RecordKindRunInterrupted      RecordKind = "run.interrupted"
	RecordKindMessageCreated      RecordKind = "message.created"
	RecordKindStepCommitted       RecordKind = "agent.step.committed"
	RecordKindHistoryAppended     RecordKind = "history.appended"
	RecordKindInterruptRequested  RecordKind = "run.interrupt.requested"
	RecordKindResponseAdmitted    RecordKind = "model.response.admitted"
	RecordKindReplyPlanned        RecordKind = "outbox.planned"
	RecordKindDeliveryStarted     RecordKind = "delivery.started"
	RecordKindDeliverySent        RecordKind = "delivery.sent"
	RecordKindDeliveryFailed      RecordKind = "delivery.failed"
	RecordKindContextCheckpoint   RecordKind = "context.checkpoint.created"
	RecordKindCommandCompleted    RecordKind = "conversation.command.completed"
	RecordKindMemoryVersion       RecordKind = "memory.version.created"
)

type Record struct {
	Seq             int64
	ID              string
	CommitID        string
	ConversationID  string
	RunID           string
	Kind            RecordKind
	SchemaVersion   int
	SourceNamespace string
	SourceEventID   string
	Payload         json.RawMessage
	PayloadSHA256   [sha256.Size]byte
	CreatedAt       time.Time
}

func NewRecord(id, commitID string, kind RecordKind, schemaVersion int, payload json.RawMessage) (Record, error) {
	if id == "" {
		return Record{}, errors.New("record ID is required")
	}
	if commitID == "" {
		return Record{}, errors.New("record commit ID is required")
	}
	if kind == "" {
		return Record{}, errors.New("record kind is required")
	}
	if schemaVersion < 1 {
		return Record{}, errors.New("record schema version must be positive")
	}
	if !json.Valid(payload) {
		return Record{}, errors.New("record payload is not valid JSON")
	}
	payload = append(json.RawMessage(nil), payload...)
	return Record{
		ID:            id,
		CommitID:      commitID,
		Kind:          kind,
		SchemaVersion: schemaVersion,
		Payload:       payload,
		PayloadSHA256: sha256.Sum256(payload),
		CreatedAt:     time.Now().UTC(),
	}, nil
}

func (r Record) Validate() error {
	if r.ID == "" || r.CommitID == "" || r.Kind == "" {
		return errors.New("record identity is incomplete")
	}
	if r.SchemaVersion < 1 {
		return errors.New("record schema version must be positive")
	}
	if !json.Valid(r.Payload) {
		return errors.New("record payload is not valid JSON")
	}
	if got := sha256.Sum256(r.Payload); got != r.PayloadSHA256 {
		return errors.New("record payload digest does not match")
	}
	if r.Kind == RecordKindIngressReceived && (r.SourceNamespace == "" || r.SourceEventID == "") {
		return errors.New("ingress record source identity is required")
	}
	if r.Kind == RecordKindCommandCompleted && (r.SourceNamespace == "" || r.SourceEventID == "") {
		return errors.New("conversation command source identity is required")
	}
	return nil
}

type CacheControlDTO struct {
	Type string `json:"type"`
	TTL  string `json:"ttl,omitempty"`
}

type UsageDTO struct {
	InputTokens           int `json:"inputTokens"`
	OutputTokens          int `json:"outputTokens"`
	TotalTokens           int `json:"totalTokens"`
	ReasoningTokens       int `json:"reasoningTokens"`
	CachedInputTokens     int `json:"cachedInputTokens"`
	NoCacheTokens         int `json:"noCacheTokens"`
	CacheReadTokens       int `json:"cacheReadTokens"`
	CacheWriteTokens      int `json:"cacheWriteTokens"`
	CacheWrite5mTokens    int `json:"cacheWrite5mTokens"`
	CacheWrite1hTokens    int `json:"cacheWrite1hTokens"`
	TextTokens            int `json:"textTokens"`
	OutputReasoningTokens int `json:"outputReasoningTokens"`
}

type ResponseDTO struct {
	ID        string            `json:"id,omitempty"`
	ModelID   string            `json:"modelId,omitempty"`
	Timestamp time.Time         `json:"timestamp"`
	Headers   map[string]string `json:"headers,omitempty"`
}

type StepDTO struct {
	Sequence        int64       `json:"sequence"`
	FinishReason    string      `json:"finishReason"`
	RawFinishReason string      `json:"rawFinishReason,omitempty"`
	Response        ResponseDTO `json:"response"`
}

type PartType string

const (
	PartTypeText       PartType = "text"
	PartTypeReasoning  PartType = "reasoning"
	PartTypeImage      PartType = "image"
	PartTypeFile       PartType = "file"
	PartTypeToolCall   PartType = "tool_call"
	PartTypeToolResult PartType = "tool_result"
)

type PartDTO struct {
	Type       PartType           `json:"type"`
	Text       *TextPartDTO       `json:"text,omitempty"`
	Reasoning  *ReasoningPartDTO  `json:"reasoning,omitempty"`
	Image      *ImagePartDTO      `json:"image,omitempty"`
	File       *FilePartDTO       `json:"file,omitempty"`
	ToolCall   *ToolCallPartDTO   `json:"toolCall,omitempty"`
	ToolResult *ToolResultPartDTO `json:"toolResult,omitempty"`
}

type TextPartDTO struct {
	Text             string           `json:"text"`
	CacheControl     *CacheControlDTO `json:"cacheControl,omitempty"`
	ProviderMetadata json.RawMessage  `json:"providerMetadata,omitempty"`
}

type ReasoningPartDTO struct {
	ID               string          `json:"id,omitempty"`
	Text             string          `json:"text"`
	Format           string          `json:"format,omitempty"`
	Model            string          `json:"model,omitempty"`
	ProviderMetadata json.RawMessage `json:"providerMetadata,omitempty"`
}

type ImagePartDTO struct {
	URL          string           `json:"url"`
	MediaType    string           `json:"mediaType,omitempty"`
	CacheControl *CacheControlDTO `json:"cacheControl,omitempty"`
}

type FilePartDTO struct {
	Path         string           `json:"path"`
	MediaType    string           `json:"mediaType,omitempty"`
	Filename     string           `json:"filename,omitempty"`
	CacheControl *CacheControlDTO `json:"cacheControl,omitempty"`
}

type ToolCallPartDTO struct {
	ToolCallID       string           `json:"toolCallId"`
	ToolName         string           `json:"toolName"`
	Input            json.RawMessage  `json:"input"`
	CacheControl     *CacheControlDTO `json:"cacheControl,omitempty"`
	ProviderMetadata json.RawMessage  `json:"providerMetadata,omitempty"`
}

type ToolResultPartDTO struct {
	ToolCallID   string           `json:"toolCallId"`
	ToolName     string           `json:"toolName"`
	Result       json.RawMessage  `json:"result"`
	IsError      bool             `json:"isError,omitempty"`
	CacheControl *CacheControlDTO `json:"cacheControl,omitempty"`
}

type MessageDTO struct {
	Role        string    `json:"role"`
	Parts       []PartDTO `json:"parts"`
	Usage       *UsageDTO `json:"usage,omitempty"`
	Step        *StepDTO  `json:"step,omitempty"`
	StopReason  string    `json:"stopReason,omitempty"`
	AbortReason string    `json:"abortReason,omitempty"`
}

type EncodedMessage struct {
	Message MessageDTO
}

type HistoryAppendedPayload struct {
	FirstHistorySeq  int64    `json:"firstHistorySeq"`
	MessageRecordIDs []string `json:"messageRecordIds"`
	InputRevision    int64    `json:"inputRevision,omitempty"`
}
