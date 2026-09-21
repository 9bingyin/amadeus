package mcp

import "testing"

func TestSafeMCPToolName(t *testing.T) {
	used := map[string]string{"read": "local tools"}
	name, err := safeMCPToolName("exa", "web_search", used)
	if err != nil {
		t.Fatalf("safeMCPToolName() error = %v", err)
	}
	if name != "exa__web_search" {
		t.Fatalf("name = %q", name)
	}

	prefixed, err := safeMCPToolName("remote", "read", used)
	if err != nil {
		t.Fatalf("safeMCPToolName() error = %v", err)
	}
	if prefixed != "remote__read" {
		t.Fatalf("prefixed = %q", prefixed)
	}
	used[prefixed] = "remote"

	issue, err := safeMCPToolName("github", "create-issue", used)
	if err != nil {
		t.Fatalf("safeMCPToolName() error = %v", err)
	}
	if issue != "github__create-issue" {
		t.Fatalf("issue = %q", issue)
	}

	numeric, err := safeMCPToolName("12306", "2024.query", used)
	if err != nil {
		t.Fatalf("safeMCPToolName() error = %v", err)
	}
	if numeric != "mcp-12306__tool-2024-query" {
		t.Fatalf("numeric = %q", numeric)
	}

	first, err := safeMCPToolName("files", "read.file", map[string]string{})
	if err != nil {
		t.Fatalf("safeMCPToolName() error = %v", err)
	}
	second, err := safeMCPToolName("files", "read-file", map[string]string{first: "files"})
	if err != nil {
		t.Fatalf("safeMCPToolName() error = %v", err)
	}
	if first != "files__read-file" || second != "files__read-file-2" {
		t.Fatalf("collision = %q, %q", first, second)
	}
}
