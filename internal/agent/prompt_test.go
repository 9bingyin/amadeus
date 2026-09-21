package agent

import (
	"runtime"
	"strings"
	"testing"
)

func TestBuildSystemPrompt(t *testing.T) {
	prompt := BuildSystemPrompt("/home/user/.amadeus/workspace", true, "load SKILL.md\n<available_skills>\n</available_skills>")
	if !strings.HasPrefix(prompt, "You are a personal assistant.\n\n") {
		t.Fatalf("BuildSystemPrompt() = %q", prompt)
	}
	for _, want := range []string{
		"<telegram>\nEach user message starts with [Telegram #<id> <sender> <time>]",
		"Write replies with only the formatting Telegram shows:",
		"Do not use headings, tables, images, or HTML.",
		"Reply in the user's language.\n</telegram>",
		"<tools>\n- read: Read file contents",
		"<rules>\n- Use bash for file operations like ls, rg, find",
		"<skills>\nload SKILL.md",
		"<cwd>\n/home/user/.amadeus/workspace\n</cwd>",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("BuildSystemPrompt() = %q, want containing %q", prompt, want)
		}
	}
	if strings.Contains(prompt, "Amadeus") {
		t.Fatalf("BuildSystemPrompt() names the agent: %q", prompt)
	}
	system := section(t, prompt, "system")
	for _, want := range []string{runtime.GOOS, runtime.GOARCH} {
		if !strings.Contains(system, want) {
			t.Fatalf("system = %q, want containing %q", system, want)
		}
	}
}

func TestBuildSystemPromptOmitsOptionalSections(t *testing.T) {
	prompt := BuildSystemPrompt("/tmp/workspace", false, " \n")
	if strings.Contains(prompt, "<telegram>") || strings.Contains(prompt, "<skills>") {
		t.Fatalf("BuildSystemPrompt() = %q", prompt)
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
