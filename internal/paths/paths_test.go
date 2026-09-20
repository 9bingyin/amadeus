package paths

import (
	"path/filepath"
	"testing"
)

func TestDirectoryRejectsRelativeHome(t *testing.T) {
	t.Setenv("AMADEUS_HOME", "")
	t.Setenv("HOME", ".")
	if _, err := Directory(); err == nil {
		t.Fatal("Directory() unexpectedly accepted relative HOME")
	}
}

func TestDirectoryRejectsRelativeOverride(t *testing.T) {
	t.Setenv("AMADEUS_HOME", "relative")
	if _, err := Directory(); err == nil {
		t.Fatal("Directory() unexpectedly accepted relative AMADEUS_HOME")
	}
}

func TestDefaultPaths(t *testing.T) {
	home := t.TempDir()
	t.Setenv("AMADEUS_HOME", "")
	t.Setenv("HOME", home)

	directory, err := Directory()
	if err != nil {
		t.Fatalf("Directory() error = %v", err)
	}
	if want := filepath.Join(home, ".amadeus"); directory != want {
		t.Fatalf("Directory() = %q, want %q", directory, want)
	}
	configFile, err := ConfigFile()
	if err != nil {
		t.Fatalf("ConfigFile() error = %v", err)
	}
	if want := filepath.Join(home, ".amadeus", "config.json"); configFile != want {
		t.Fatalf("ConfigFile() = %q, want %q", configFile, want)
	}
	skillsDirectory, err := SkillsDirectory()
	if err != nil {
		t.Fatalf("SkillsDirectory() error = %v", err)
	}
	if want := filepath.Join(home, ".amadeus", "skills"); skillsDirectory != want {
		t.Fatalf("SkillsDirectory() = %q, want %q", skillsDirectory, want)
	}
	workspaceDirectory, err := WorkspaceDirectory("")
	if err != nil {
		t.Fatalf("WorkspaceDirectory() error = %v", err)
	}
	if want := filepath.Join(home, ".amadeus", "workspace"); workspaceDirectory != want {
		t.Fatalf("WorkspaceDirectory() = %q, want %q", workspaceDirectory, want)
	}
}

func TestConfiguredDirectoryAndWorkspace(t *testing.T) {
	directory := t.TempDir()
	t.Setenv("AMADEUS_HOME", directory)

	got, err := Directory()
	if err != nil {
		t.Fatalf("Directory() error = %v", err)
	}
	if got != directory {
		t.Fatalf("Directory() = %q, want %q", got, directory)
	}
	relativeWorkspace, err := WorkspaceDirectory("agent-workspace")
	if err != nil {
		t.Fatalf("WorkspaceDirectory() error = %v", err)
	}
	if want := filepath.Join(directory, "agent-workspace"); relativeWorkspace != want {
		t.Fatalf("relative workspace = %q, want %q", relativeWorkspace, want)
	}
	absolute := filepath.Join(t.TempDir(), "workspace")
	absoluteWorkspace, err := WorkspaceDirectory(absolute)
	if err != nil {
		t.Fatalf("WorkspaceDirectory() error = %v", err)
	}
	if absoluteWorkspace != absolute {
		t.Fatalf("absolute workspace = %q, want %q", absoluteWorkspace, absolute)
	}
}
