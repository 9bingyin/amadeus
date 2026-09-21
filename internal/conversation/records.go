package conversation

import "encoding/json"

type ConversationCreatedPayload struct {
	Platform         string `json:"platform"`
	AccountID        string `json:"accountId"`
	ExternalChatID   string `json:"externalChatId"`
	ExternalThreadID string `json:"externalThreadId"`
}

type SessionStartedPayload struct {
	SessionID         string `json:"sessionId"`
	PreviousSessionID string `json:"previousSessionId"`
	StartHistorySeq   int64  `json:"startHistorySeq"`
	Cause             string `json:"cause"`
}

type RunCreatedPayload struct {
	SessionID        string          `json:"sessionId,omitempty"`
	Provider         string          `json:"provider"`
	Model            string          `json:"model"`
	ReasoningEffort  string          `json:"reasoningEffort,omitempty"`
	SystemPrompt     string          `json:"systemPrompt"`
	Config           json.RawMessage `json:"config,omitempty"`
	InputWindowMS    int64           `json:"inputWindowMs,omitempty"`
	InputNotBeforeMS int64           `json:"inputNotBeforeMs,omitempty"`
}

type MessageRecordPayload struct {
	Message        MessageDTO `json:"message"`
	SourceRecordID string     `json:"sourceRecordId,omitempty"`
	StepSeq        *int64     `json:"stepSeq,omitempty"`
	StepMessageSeq *int64     `json:"stepMessageSeq,omitempty"`
}

type StepCommittedPayload struct {
	StepSeq          int64    `json:"stepSeq"`
	MessageRecordIDs []string `json:"messageRecordIds"`
	Final            bool     `json:"final"`
}

type RunStatusPayload struct {
	Status       string `json:"status"`
	ErrorCode    string `json:"errorCode,omitempty"`
	ErrorMessage string `json:"errorMessage,omitempty"`
}

type InterruptRequestedPayload struct {
	InputRevision    int64 `json:"inputRevision"`
	InputNotBeforeMS int64 `json:"inputNotBeforeMs"`
}

type ResponseAdmittedPayload struct {
	RequestSequence int64 `json:"requestSequence"`
	InputRevision   int64 `json:"inputRevision"`
}

type ContextCheckpointPayload struct {
	SessionID               string       `json:"sessionId,omitempty"`
	Cause                   string       `json:"cause"`
	ParentRecordID          string       `json:"parentRecordId,omitempty"`
	SourceHistoryThroughSeq int64        `json:"sourceHistoryThroughSeq"`
	SourceInputRevision     int64        `json:"sourceInputRevision"`
	Replacement             []MessageDTO `json:"replacement"`
	SummaryModel            string       `json:"summaryModel"`
	SummaryPromptVersion    int          `json:"summaryPromptVersion"`
	SummaryUsage            *UsageDTO    `json:"summaryUsage,omitempty"`
	EstimatedTokensBefore   int          `json:"estimatedTokensBefore"`
	EstimatedTokensAfter    int          `json:"estimatedTokensAfter"`
}

type CommandCompletedPayload struct {
	Command   string `json:"command"`
	Result    string `json:"result"`
	SessionID string `json:"sessionId,omitempty"`
}

type OutboxPlannedPayload struct {
	OutboxID        string          `json:"outboxId"`
	MessageRecordID string          `json:"messageRecordId,omitempty"`
	ReplyToRecordID string          `json:"replyToRecordId,omitempty"`
	Kind            string          `json:"kind"`
	ChunkIndex      int             `json:"chunkIndex"`
	ChunkCount      int             `json:"chunkCount"`
	Payload         json.RawMessage `json:"payload"`
}

type DeliveryPayload struct {
	OutboxID  string `json:"outboxId"`
	Attempt   int64  `json:"attempt"`
	Error     string `json:"error,omitempty"`
	RetryAtMS int64  `json:"retryAtMs,omitempty"`
	Dead      bool   `json:"dead,omitempty"`
}
