package mcp

import (
	"context"
	"strings"
	"testing"

	"github.com/felinics/twilight/sdk"
	"github.com/google/jsonschema-go/jsonschema"
	mcpsdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestLoadHidesMCPToolsUntilListed(t *testing.T) {
	set := loadCatalog(t, Server{
		Name: "github", Transport: "http", URL: "https://example.com",
		DirectTools:  DirectTools{Names: []string{"get_file_contents"}},
		IncludeTools: []string{"search_*", "get_*"},
		ExcludeTools: []string{"delete_*", "github__search_hidden"},
	}, []sdk.Tool{
		{Name: "search_repositories", Description: "Search GitHub repositories", Parameters: repositorySchema()},
		{Name: "get_file_contents", Description: "Read a file"},
		{Name: "delete_repository", Description: "Delete a repository"},
		{Name: "search_hidden", Description: "Search hidden"},
		{Name: "list_issues", Description: "List repository issues"},
	})

	if got := toolNames(set.Tools()); !equalStrings(got, []string{"github__get_file_contents", "tool_call", "tools_list"}) {
		t.Fatalf("tool names = %v", got)
	}
	servers, err := findTool(t, set, "tools_list").Execute(nil, map[string]any{})
	if err != nil {
		t.Fatalf("tools_list error = %v", err)
	}
	if servers != "github" {
		t.Fatalf("tools_list servers = %#v", servers)
	}
	result, err := findTool(t, set, "tools_list").Execute(nil, map[string]any{"server": "github"})
	if err != nil {
		t.Fatalf("tools_list server error = %v", err)
	}
	text, ok := result.(string)
	if !ok {
		t.Fatalf("tools_list result = %#v", result)
	}
	if !strings.Contains(text, "github__search_repositories") || strings.Contains(text, "github__get_file_contents") ||
		strings.Contains(text, "delete_repository") || strings.Contains(text, "search_hidden") || strings.Contains(text, "list_issues") {
		t.Fatalf("tools_list result = %q", text)
	}
	if _, err := findTool(t, set, "tools_list").Execute(nil, map[string]any{"server": "gitlab"}); err == nil {
		t.Fatal("tools_list accepted an unknown server")
	}
	for _, want := range []string{"query: string, required — search query", "sort: \"stars\" | \"forks\" | \"updated\""} {
		if !strings.Contains(text, want) {
			t.Fatalf("tools_list result = %q, want containing %q", text, want)
		}
	}

	call := findTool(t, set, "tool_call")
	called, err := call.Execute(&sdk.ToolExecContext{Context: t.Context()}, map[string]any{
		"name": "github__search_repositories", "arguments": map[string]any{"query": "amadeus"},
	})
	if err != nil {
		t.Fatalf("tool_call error = %v", err)
	}
	if called != "called:amadeus" {
		t.Fatalf("tool_call result = %#v", called)
	}
	if _, err := call.Execute(nil, map[string]any{"name": "github__delete_repository"}); err == nil {
		t.Fatal("tool_call accepted an excluded tool")
	}
}

func TestToolsListReturnsEveryHiddenTool(t *testing.T) {
	set := loadCatalog(t, Server{Name: "docs", Transport: "http", URL: "https://example.com"}, []sdk.Tool{
		{Name: "read_notes", Description: "Contains the word alpha"},
		{Name: "alpha", Description: "First"},
	})
	listed, err := findTool(t, set, "tools_list").Execute(nil, nil)
	if err != nil {
		t.Fatalf("tools_list error = %v", err)
	}
	if listed != "docs" {
		t.Fatalf("tools_list servers = %#v", listed)
	}
	result, err := findTool(t, set, "tools_list").Execute(nil, map[string]any{"server": "docs"})
	if err != nil {
		t.Fatalf("tools_list server error = %v", err)
	}
	text, _ := result.(string)
	alpha := strings.Index(text, "docs__alpha\n")
	notes := strings.Index(text, "docs__read_notes\n")
	if alpha < 0 || notes < alpha {
		t.Fatalf("tools_list result = %q", text)
	}
}

func TestToolsListDefaultsToServerNames(t *testing.T) {
	set, err := load(t.Context(), t.TempDir(), []Server{
		{Name: "firecrawl", Transport: "http", URL: "https://firecrawl.example"},
		{Name: "exa", Transport: "http", URL: "https://exa.example"},
	}, nil, func(_ context.Context, config *sdk.MCPClientConfig) (client, error) {
		transport, _ := config.Transport.(*mcpsdk.StreamableClientTransport)
		if transport != nil && transport.Endpoint == "https://exa.example" {
			return &fakeClient{tools: []sdk.Tool{{Name: "web_search", Description: "Search the web"}}}, nil
		}
		return &fakeClient{tools: []sdk.Tool{{Name: "scrape", Description: "Scrape a page"}}}, nil
	})
	if err != nil {
		t.Fatalf("load() error = %v", err)
	}
	t.Cleanup(func() {
		if err := set.Close(); err != nil {
			t.Errorf("Close() error = %v", err)
		}
	})
	listed, err := findTool(t, set, "tools_list").Execute(nil, map[string]any{})
	if err != nil {
		t.Fatalf("tools_list error = %v", err)
	}
	if listed != "exa\nfirecrawl" {
		t.Fatalf("tools_list servers = %#v", listed)
	}
	result, err := findTool(t, set, "tools_list").Execute(nil, map[string]any{"server": "exa"})
	if err != nil {
		t.Fatalf("tools_list exa error = %v", err)
	}
	text, _ := result.(string)
	if !strings.Contains(text, "exa__web_search") || strings.Contains(text, "firecrawl") {
		t.Fatalf("tools_list exa = %q", text)
	}
}

func loadCatalog(t *testing.T, server Server, tools []sdk.Tool) *Set {
	t.Helper()
	for index := range tools {
		if tools[index].Execute != nil {
			continue
		}
		tools[index].Execute = func(_ *sdk.ToolExecContext, input any) (any, error) {
			arguments, _ := input.(map[string]any)
			return "called:" + arguments["query"].(string), nil
		}
	}
	set, err := load(t.Context(), t.TempDir(), []Server{server}, nil, func(context.Context, *sdk.MCPClientConfig) (client, error) {
		return &fakeClient{tools: tools}, nil
	})
	if err != nil {
		t.Fatalf("load() error = %v", err)
	}
	t.Cleanup(func() {
		if err := set.Close(); err != nil {
			t.Errorf("Close() error = %v", err)
		}
	})
	return set
}

func findTool(t *testing.T, set *Set, name string) sdk.Tool {
	t.Helper()
	for _, tool := range set.Tools() {
		if tool.Name == name {
			return tool
		}
	}
	t.Fatalf("tool %q is not registered: %v", name, toolNames(set.Tools()))
	return sdk.Tool{}
}

func equalStrings(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func repositorySchema() *jsonschema.Schema {
	return &jsonschema.Schema{
		Type:     "object",
		Required: []string{"query"},
		Properties: map[string]*jsonschema.Schema{
			"query": {Type: "string", Description: "search query"},
			"sort":  {Enum: []any{"stars", "forks", "updated"}},
		},
	}
}
