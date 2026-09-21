package conversation

import (
	"encoding/json"
	"testing"
)

func TestRecordValidation(t *testing.T) {
	record, err := NewRecord("record-1", "commit-1", RecordKindRunCreated, 1, json.RawMessage(`{"run":"run-1"}`))
	if err != nil {
		t.Fatalf("NewRecord() error = %v", err)
	}
	if err := record.Validate(); err != nil {
		t.Fatalf("Validate() error = %v", err)
	}
	record.Payload[0] = '['
	if err := record.Validate(); err == nil {
		t.Fatal("Validate() error = nil after payload mutation")
	}
}

func TestIngressRecordRequiresSourceIdentity(t *testing.T) {
	record, err := NewRecord("record-1", "commit-1", RecordKindIngressReceived, 1, json.RawMessage(`{}`))
	if err != nil {
		t.Fatalf("NewRecord() error = %v", err)
	}
	if err := record.Validate(); err == nil {
		t.Fatal("Validate() error = nil")
	}
	record.SourceNamespace = "telegram:123"
	record.SourceEventID = "456"
	if err := record.Validate(); err != nil {
		t.Fatalf("Validate() error = %v", err)
	}
}
