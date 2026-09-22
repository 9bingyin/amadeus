package agent

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestBuildSystemPrompt(t *testing.T) {
	prompt := BuildSystemPrompt("/home/user/.amadeus/workspace", true, false, "load SKILL.md\n<available_skills>\n</available_skills>", "", "", "")
	if !strings.HasPrefix(prompt, "You are a personal assistant.\n\n") {
		t.Fatalf("BuildSystemPrompt() = %q", prompt)
	}
	for _, want := range []string{
		"<telegram>\nEach user message starts with [Telegram #<id> <sender> <time>]",
		"Write replies with only the formatting Telegram shows:",
		"Do not use headings, tables, images, or HTML.",
		"Use send_file to send a local file to this chat.",
		"Reply in the user's language.\n</telegram>",
		"<tools>\n- read: Read file contents",
		"session_search: Search this chat's saved sessions, including the current one. Returns session and message numbers",
		"session_read: Read one saved session by its number. offset is the message number from session_search",
		"<rules>\n- Use bash for file operations like ls, rg, find",
		"<skills>\nload SKILL.md",
		"<cwd>\n/home/user/.amadeus/workspace\n</cwd>",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("BuildSystemPrompt() = %q, want containing %q", prompt, want)
		}
	}
	if strings.Contains(prompt, "Amadeus") || strings.Contains(prompt, "tools_list") || strings.Contains(prompt, "tool_call") {
		t.Fatalf("BuildSystemPrompt() = %q", prompt)
	}
	system := section(t, prompt, "system")
	for _, want := range []string{runtime.GOOS, runtime.GOARCH} {
		if !strings.Contains(system, want) {
			t.Fatalf("system = %q, want containing %q", system, want)
		}
	}
}

func TestBuildSystemPromptListsHiddenMCPTools(t *testing.T) {
	prompt := BuildSystemPrompt("/tmp/workspace", false, true, "", "", "", "")
	tools := section(t, prompt, "tools")
	for _, want := range []string{
		"- session_read: Read one saved session by its number. offset is the message number from session_search\n- tools_list: List hidden MCP servers.",
		"- tool_call: Call an MCP tool by the name and arguments returned from tools_list\n\nIn addition to the tools above",
	} {
		if !strings.Contains(tools, want) {
			t.Fatalf("tools = %q, want containing %q", tools, want)
		}
	}
}

func TestBuildSystemPromptOmitsOptionalSections(t *testing.T) {
	prompt := BuildSystemPrompt("/tmp/workspace", false, false, " \n", " \n", " ", " ")
	if strings.Contains(prompt, "<telegram>") || strings.Contains(prompt, "send_file") ||
		strings.Contains(prompt, "<skills>") || strings.Contains(prompt, "<agents>") ||
		strings.Contains(prompt, "<workspace-agents>") {
		t.Fatalf("BuildSystemPrompt() = %q", prompt)
	}
	if !strings.HasPrefix(prompt, "You are a personal assistant.\n\n") {
		t.Fatalf("BuildSystemPrompt() = %q", prompt)
	}
	if !strings.Contains(prompt, "session_search") || !strings.Contains(prompt, "session_read") {
		t.Fatalf("BuildSystemPrompt() = %q", prompt)
	}
}

func TestBuildSystemPromptUsesSoulAndAgents(t *testing.T) {
	prompt := BuildSystemPrompt("/tmp/workspace", false, false, "skills", "Be brief.", "Global rule.", "Workspace rule.")
	if strings.Contains(prompt, "You are a personal assistant.") {
		t.Fatalf("BuildSystemPrompt() keeps the default identity: %q", prompt)
	}
	if !strings.HasPrefix(prompt, "Be brief.\n\n") {
		t.Fatalf("BuildSystemPrompt() = %q", prompt)
	}
	rules := strings.Index(prompt, "<rules>")
	agents := strings.Index(prompt, "<agents>\nGlobal rule.\n</agents>")
	workspaceAgents := strings.Index(prompt, "<workspace-agents>\nWorkspace rule.\n</workspace-agents>")
	skills := strings.Index(prompt, "<skills>\nskills\n</skills>")
	if rules < 0 || agents < rules || workspaceAgents < agents || skills < workspaceAgents {
		t.Fatalf("BuildSystemPrompt() = %q", prompt)
	}
}

func TestLoadPromptFiles(t *testing.T) {
	home := t.TempDir()
	workspace := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, "SOUL.md"), []byte("  Be brief. \n"), 0o600); err != nil {
		t.Fatalf("write SOUL.md: %v", err)
	}
	if err := os.WriteFile(filepath.Join(home, "AGENTS.md"), []byte("Global rule.\n"), 0o600); err != nil {
		t.Fatalf("write AGENTS.md: %v", err)
	}
	if err := os.WriteFile(filepath.Join(workspace, "AGENTS.md"), []byte("\n"), 0o600); err != nil {
		t.Fatalf("write workspace AGENTS.md: %v", err)
	}

	soul, globalAgents, workspaceAgents, err := LoadPromptFiles(home, workspace)
	if err != nil {
		t.Fatalf("LoadPromptFiles() error = %v", err)
	}
	if soul != "Be brief." || globalAgents != "Global rule." || workspaceAgents != "" {
		t.Fatalf("LoadPromptFiles() = %q, %q, %q", soul, globalAgents, workspaceAgents)
	}

	if err := os.WriteFile(filepath.Join(workspace, "AGENTS.md"), []byte("Workspace rule."), 0o600); err != nil {
		t.Fatalf("rewrite workspace AGENTS.md: %v", err)
	}
	_, _, workspaceAgents, err = LoadPromptFiles(home, workspace)
	if err != nil {
		t.Fatalf("LoadPromptFiles() workspace error = %v", err)
	}
	if workspaceAgents != "Workspace rule." {
		t.Fatalf("workspace agents = %q", workspaceAgents)
	}

	_, globalAgents, workspaceAgents, err = LoadPromptFiles(home, home)
	if err != nil {
		t.Fatalf("LoadPromptFiles() duplicate error = %v", err)
	}
	if globalAgents != "Global rule." || workspaceAgents != "" {
		t.Fatalf("duplicate agents = %q, %q", globalAgents, workspaceAgents)
	}
}

func TestOSReleasePretty(t *testing.T) {
	got := osReleasePretty(`NAME=NixOS
VERSION="26.11 (Zokor)"
PRETTY_NAME="NixOS 26.11 (Zokor)"
`)
	if got != "NixOS 26.11 (Zokor)" {
		t.Fatalf("osReleasePretty() = %q", got)
	}
	got = osReleasePretty("NAME=Debian\nVERSION_ID=\"12\"\n")
	if got != "Debian 12" {
		t.Fatalf("osReleasePretty() fallback = %q", got)
	}
}

func TestDescribeSystemIncludesRelease(t *testing.T) {
	summary := describeSystem()
	if !strings.Contains(summary, runtime.GOOS) || !strings.Contains(summary, runtime.GOARCH) {
		t.Fatalf("describeSystem() = %q", summary)
	}
	if runtime.GOOS == "linux" && !strings.Contains(summary, ";") {
		t.Fatalf("describeSystem() = %q, want a distro name", summary)
	}
}

func section(t *testing.T, prompt, name string) string {
	t.Helper()
	start := strings.Index(prompt, "<"+name+">\n")
	end := strings.Index(prompt, "\n</"+name+">")
	if start < 0 || end < start {
		t.Fatalf("section %s missing in %q", name, prompt)
	}
	return prompt[start+len(name)+3 : end]
}
