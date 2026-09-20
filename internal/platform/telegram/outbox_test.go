package telegram

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/9bingyin/amadeus/internal/conversation"
)

func TestPlanOutboxFreezesTelegramChunks(t *testing.T) {
	source, err := json.Marshal(ingressPayload{MessageID: 42, ChatID: 100, ThreadID: 7, Raw: json.RawMessage(`{"update_id":1}`)})
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}
	chunks, err := PlanOutbox(conversation.FinalReply{
		Route:              conversation.Route{Platform: "telegram", AccountID: "bot", ChatID: "100", ThreadID: "7"},
		ReplySourcePayload: source, Kind: "final", Text: "**bold**",
	})
	if err != nil {
		t.Fatalf("PlanOutbox() error = %v", err)
	}
	if len(chunks) != 1 || chunks[0].Kind != "final" {
		t.Fatalf("chunks = %#v", chunks)
	}
	var payload outboxPayload
	if err := json.Unmarshal(chunks[0].Payload, &payload); err != nil {
		t.Fatalf("Unmarshal() error = %v", err)
	}
	if payload.ChatID != 100 || payload.ThreadID != 7 || payload.ReplyToMessageID != 42 || payload.Text != "bold" {
		t.Fatalf("payload = %#v", payload)
	}
	if len(payload.Entities) != 1 || payload.Entities[0].Type != "bold" {
		t.Fatalf("entities = %#v", payload.Entities)
	}
}

func TestDeliverOutboxCompletesPersistedChunk(t *testing.T) {
	payload, err := json.Marshal(outboxPayload{ChatID: 100, ReplyToMessageID: 42, Text: "done"})
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}
	source := &fakeOutboxSource{attempt: 1}
	sender := &fakeSender{}
	service := &Service{fatalErrors: make(chan error, 1)}
	item := conversation.PendingOutbox{ID: "outbox-1", ChunkIndex: 0, Payload: payload}
	if err := service.deliverOutbox(t.Context(), source, sender, item); err != nil {
		t.Fatalf("deliverOutbox() error = %v", err)
	}
	if source.started != "outbox-1" || source.completed != "outbox-1" {
		t.Fatalf("source = %#v", source)
	}
	if len(sender.messages) != 1 || sender.messages[0].ReplyParameters.MessageID != 42 {
		t.Fatalf("messages = %#v", sender.messages)
	}
}

type fakeOutboxSource struct {
	ready     chan struct{}
	attempt   int64
	started   string
	completed string
	failed    string
}

func (s *fakeOutboxSource) OutboxReady() <-chan struct{} {
	if s.ready == nil {
		s.ready = make(chan struct{})
	}
	return s.ready
}

func (*fakeOutboxSource) PendingOutbox(context.Context, time.Time) ([]conversation.PendingOutbox, error) {
	return nil, nil
}

func (*fakeOutboxSource) NextOutboxAt(context.Context) (time.Time, bool, error) {
	return time.Time{}, false, nil
}

func (s *fakeOutboxSource) StartDelivery(_ context.Context, outboxID string) (int64, error) {
	s.started = outboxID
	return s.attempt, nil
}

func (s *fakeOutboxSource) CompleteDelivery(_ context.Context, outboxID string) error {
	s.completed = outboxID
	return nil
}

func (s *fakeOutboxSource) FailDelivery(
	_ context.Context,
	outboxID, _ string,
	_ time.Time,
	_ bool,
) error {
	s.failed = outboxID
	return nil
}
