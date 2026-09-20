package skills

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestDiscoverReturnsEmptyForMissingDirectory(t *testing.T) {
	available, err := Discover(filepath.Join(t.TempDir(), "missing"))
	if err != nil {
		t.Fatalf("Discover() error = %v", err)
	}
	if len(available) != 0 {
		t.Fatalf("skills = %#v, want empty", available)
	}
}

func TestDiscoverRejectsNonDirectoryRoot(t *testing.T) {
	path := filepath.Join(t.TempDir(), "skills")
	if err := os.WriteFile(path, []byte("not a directory"), 0o600); err != nil {
		t.Fatalf("write root: %v", err)
	}
	if _, err := Discover(path); err == nil {
		t.Fatal("Discover() unexpectedly accepted a file root")
	}
}

func TestDiscoverFollowsRootSymlink(t *testing.T) {
	target := t.TempDir()
	writeSkill(t, target, "linked/SKILL.md", `---
name: linked
description: Loaded through a linked root.
---
`)
	root := filepath.Join(t.TempDir(), "skills")
	if err := os.Symlink(target, root); err != nil {
		t.Fatalf("create root symlink: %v", err)
	}
	available, err := Discover(root)
	if err != nil {
		t.Fatalf("Discover() error = %v", err)
	}
	if len(available) != 1 || available[0].Name != "linked" {
		t.Fatalf("skills = %#v", available)
	}
}

func TestDiscoverGlobalSkills(t *testing.T) {
	root := t.TempDir()
	writeSkill(t, root, "group/zeta/SKILL.md", `---
name: zeta
description: Use for zeta tasks.
---
# Zeta
`)
	writeSkill(t, root, "alpha/SKILL.md", "---\r\nname: alpha\r\ndescription: >-\r\n  Use for alpha tasks and\r\n  related work.\r\n---\r\n# Alpha\r\n")
	writeSkill(t, root, "disabled/SKILL.md", `---
name: disabled
description: |
  Hidden from model-driven activation.
  ---
  This line is still part of the YAML block.
disable-model-invocation: true
---
`)
	writeSkill(t, root, "malformed/SKILL.md", "# Missing frontmatter\n")
	writeSkill(t, root, "wrong-type/SKILL.md", `---
name: wrong-type
description: false
---
`)
	writeSkill(t, root, "alpha-copy/SKILL.md", `---
name: alpha
description: Duplicate.
---
`)
	writeSkill(t, root, "group/zeta/nested/SKILL.md", `---
name: nested
description: Must not be discovered below another skill root.
---
`)
	if err := os.WriteFile(filepath.Join(root, "README.md"), []byte("ignored"), 0o600); err != nil {
		t.Fatalf("write README: %v", err)
	}

	available, err := Discover(root)
	if err != nil {
		t.Fatalf("Discover() error = %v", err)
	}
	if len(available) != 2 {
		t.Fatalf("skills = %#v, want 2", available)
	}
	if available[0].Name != "alpha" || available[0].Description != "Use for alpha tasks and related work." {
		t.Fatalf("first skill = %#v", available[0])
	}
	if available[1].Name != "zeta" {
		t.Fatalf("second skill = %#v", available[1])
	}
	for _, skill := range available {
		if !filepath.IsAbs(skill.Location) {
			t.Fatalf("location = %q, want absolute path", skill.Location)
		}
	}
}

func TestDiscoverSkipsNonRegularSkill(t *testing.T) {
	root := t.TempDir()
	writeSkill(t, root, "valid/SKILL.md", `---
name: valid
description: A valid sibling.
---
`)
	nonRegularDirectory := filepath.Join(root, "non-regular")
	if err := os.MkdirAll(nonRegularDirectory, 0o700); err != nil {
		t.Fatalf("create skill directory: %v", err)
	}
	if err := os.Symlink("/dev/zero", filepath.Join(nonRegularDirectory, "SKILL.md")); err != nil {
		t.Fatalf("create skill symlink: %v", err)
	}

	available, err := Discover(root)
	if err != nil {
		t.Fatalf("Discover() error = %v", err)
	}
	if len(available) != 1 || available[0].Name != "valid" {
		t.Fatalf("skills = %#v", available)
	}
}

func TestDiscoverKeepsLenientlyInvalidName(t *testing.T) {
	root := t.TempDir()
	writeSkill(t, root, "shared/SKILL.md", `---
name: Shared_Skill
description: Imported from another agent.
---
`)

	available, err := Discover(root)
	if err != nil {
		t.Fatalf("Discover() error = %v", err)
	}
	want := []Skill{{
		Name:        "Shared_Skill",
		Description: "Imported from another agent.",
		Location:    filepath.Join(root, "shared", "SKILL.md"),
	}}
	if !reflect.DeepEqual(available, want) {
		t.Fatalf("skills = %#v, want %#v", available, want)
	}
}

func TestSystemPrompt(t *testing.T) {
	available := []Skill{{
		Name:        "review-and-test",
		Description: "Review code & run <tests>.",
		Location:    "/home/user/.amadeus/skills/review/SKILL.md",
	}}
	prompt := SystemPrompt(available)
	for _, want := range []string{
		"use the read tool to load its SKILL.md",
		"<name>review-and-test</name>",
		"<description>Review code &amp; run &lt;tests&gt;.</description>",
		"<location>/home/user/.amadeus/skills/review/SKILL.md</location>",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("SystemPrompt() = %q, want containing %q", prompt, want)
		}
	}
	if prompt := SystemPrompt(nil); prompt != "" {
		t.Fatalf("SystemPrompt(nil) = %q, want empty", prompt)
	}
}

func writeSkill(t *testing.T, root, relativePath, content string) {
	t.Helper()
	path := filepath.Join(root, filepath.FromSlash(relativePath))
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatalf("create skill directory: %v", err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write skill: %v", err)
	}
}
