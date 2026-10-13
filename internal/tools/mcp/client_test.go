package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"

	toolkit "github.com/9bingyin/amadeus/internal/tools/tool"
	mcpsdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestSessionClientPreservesRawResult(t *testing.T) {
	for _, isError := range []bool{false, true} {
		t.Run(map[bool]string{false: "success", true: "tool-error"}[isError], func(t *testing.T) {
			want := &mcpsdk.CallToolResult{
				Content: []mcpsdk.Content{
					&mcpsdk.TextContent{Text: strings.Repeat("raw\n", 2001)},
					&mcpsdk.ImageContent{Data: []byte{1, 2, 3}, MIMEType: "image/png"},
				},
				StructuredContent: map[string]any{"items": []any{"one", float64(2)}},
				IsError:           isError,
			}
			server := mcpsdk.NewServer(&mcpsdk.Implementation{Name: "test", Version: "v1"}, nil)
			server.AddTool(&mcpsdk.Tool{Name: "raw", InputSchema: json.RawMessage(`{"type":"object"}`)},
				func(context.Context, *mcpsdk.CallToolRequest) (*mcpsdk.CallToolResult, error) {
					return want, nil
				})
			server.AddTool(&mcpsdk.Tool{Name: "protocol_error", InputSchema: json.RawMessage(`{"type":"object"}`)},
				func(context.Context, *mcpsdk.CallToolRequest) (*mcpsdk.CallToolResult, error) {
					return nil, errors.New("protocol failure")
				})
			serverTransport, clientTransport := mcpsdk.NewInMemoryTransports()
			go func() { _ = server.Run(t.Context(), serverTransport) }()
			created := 0
			set, err := load(t.Context(), t.TempDir(), []Server{{Name: "test", URL: "https://unused.example"}}, nil,
				func(ctx context.Context, _ *connectionConfig) (client, error) {
					created++
					return createClient(ctx, &connectionConfig{Transport: clientTransport})
				})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				if err := set.Close(); err != nil {
					t.Error(err)
				}
			})
			for _, remote := range set.MCPTools() {
				result, err := remote.Execute(&toolkit.Context{Context: t.Context()}, map[string]any{})
				if remote.Name == "test__protocol_error" {
					if err == nil || !strings.Contains(err.Error(), "protocol failure") {
						t.Fatalf("protocol error = %v", err)
					}
					continue
				}
				if err != nil {
					t.Fatalf("Execute() error = %v", err)
				}
				raw, ok := result.(*mcpsdk.CallToolResult)
				if !ok || !reflect.DeepEqual(raw.Content, want.Content) ||
					!reflect.DeepEqual(raw.StructuredContent, want.StructuredContent) || raw.IsError != want.IsError {
					t.Fatalf("raw result not preserved: %#v", result)
				}
			}
			if created != 1 {
				t.Fatalf("clients created = %d, want 1", created)
			}
		})
	}
}
