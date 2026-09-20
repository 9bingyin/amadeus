package skills

import (
	"bufio"
	"errors"
	"fmt"
	"html"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"

	"gopkg.in/yaml.v3"
)

var validNamePattern = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)

type Skill struct {
	Name        string
	Description string
	Location    string
}

type metadata struct {
	Name                   stringValue `yaml:"name"`
	Description            stringValue `yaml:"description"`
	DisableModelInvocation bool        `yaml:"disable-model-invocation"`
}

type stringValue string

func (v *stringValue) UnmarshalYAML(node *yaml.Node) error {
	if node.Kind != yaml.ScalarNode || node.Tag != "!!str" {
		return errors.New("must be a string")
	}
	*v = stringValue(node.Value)
	return nil
}

func Discover(root string) ([]Skill, error) {
	absoluteRoot, err := filepath.Abs(root)
	if err != nil {
		return nil, fmt.Errorf("resolve skills directory: %w", err)
	}
	rootInfo, err := os.Stat(absoluteRoot)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, fmt.Errorf("stat skills directory %q: %w", absoluteRoot, err)
	}
	if !rootInfo.IsDir() {
		return nil, fmt.Errorf("skills path %q is not a directory", absoluteRoot)
	}
	scanRoot, err := filepath.EvalSymlinks(absoluteRoot)
	if err != nil {
		return nil, fmt.Errorf("resolve skills directory %q: %w", absoluteRoot, err)
	}

	byName := make(map[string]Skill)
	err = filepath.WalkDir(scanRoot, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			if path == scanRoot {
				return walkErr
			}
			slog.Warn("Skip unreadable skills path", "path", path, "err", walkErr)
			return nil
		}
		if !entry.IsDir() {
			return nil
		}
		if path != scanRoot && (entry.Name() == ".git" || entry.Name() == "node_modules") {
			return filepath.SkipDir
		}

		location := filepath.Join(path, "SKILL.md")
		info, err := os.Stat(location)
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return nil
			}
			slog.Warn("Skip unreadable skill", "path", location, "err", err)
			return filepath.SkipDir
		}
		if !info.Mode().IsRegular() {
			slog.Warn("Skip non-regular skill", "path", location, "mode", info.Mode())
			return filepath.SkipDir
		}

		skill, disabled, err := load(location)
		if err != nil {
			slog.Warn("Skip invalid skill", "path", location, "err", err)
			return filepath.SkipDir
		}
		if disabled {
			return filepath.SkipDir
		}
		if previous, exists := byName[skill.Name]; exists {
			slog.Warn("Skip duplicate skill", "name", skill.Name, "path", location, "loaded_path", previous.Location)
			return filepath.SkipDir
		}
		if len(skill.Name) > 64 || !validNamePattern.MatchString(skill.Name) {
			slog.Warn("Skill name does not follow the Agent Skills specification", "name", skill.Name, "path", location)
		}
		if utf8.RuneCountInString(skill.Description) > 1024 {
			slog.Warn("Skill description exceeds 1024 characters", "name", skill.Name, "path", location)
		}
		byName[skill.Name] = skill
		return filepath.SkipDir
	})
	if err != nil {
		return nil, fmt.Errorf("scan skills directory %q: %w", scanRoot, err)
	}

	result := make([]Skill, 0, len(byName))
	for _, skill := range byName {
		result = append(result, skill)
	}
	sort.Slice(result, func(i, j int) bool {
		return result[i].Name < result[j].Name
	})
	return result, nil
}

func load(location string) (skill Skill, disabled bool, returnErr error) {
	file, err := os.Open(location)
	if err != nil {
		return Skill{}, false, fmt.Errorf("open: %w", err)
	}
	defer func() {
		returnErr = errors.Join(returnErr, file.Close())
	}()

	scanner := bufio.NewScanner(file)
	if !scanner.Scan() {
		if err := scanner.Err(); err != nil {
			return Skill{}, false, fmt.Errorf("read YAML frontmatter: %w", err)
		}
		return Skill{}, false, errors.New("YAML frontmatter is required")
	}
	if strings.TrimSuffix(scanner.Text(), "\r") != "---" {
		return Skill{}, false, errors.New("YAML frontmatter is required")
	}
	var frontmatter strings.Builder
	closed := false
	for scanner.Scan() {
		line := strings.TrimSuffix(scanner.Text(), "\r")
		if strings.TrimRight(line, " \t") == "---" {
			closed = true
			break
		}
		frontmatter.WriteString(line)
		frontmatter.WriteByte('\n')
	}
	if err := scanner.Err(); err != nil {
		return Skill{}, false, fmt.Errorf("read YAML frontmatter: %w", err)
	}
	if !closed {
		return Skill{}, false, errors.New("YAML frontmatter is not closed")
	}

	var meta metadata
	if err := yaml.Unmarshal([]byte(frontmatter.String()), &meta); err != nil {
		return Skill{}, false, fmt.Errorf("decode YAML frontmatter: %w", err)
	}
	name := strings.TrimSpace(string(meta.Name))
	description := strings.TrimSpace(string(meta.Description))
	if name == "" {
		return Skill{}, false, errors.New("skill name is required")
	}
	if description == "" {
		return Skill{}, false, errors.New("skill description is required")
	}
	return Skill{
		Name:        name,
		Description: description,
		Location:    location,
	}, meta.DisableModelInvocation, nil
}

func SystemPrompt(available []Skill) string {
	if len(available) == 0 {
		return ""
	}

	var prompt strings.Builder
	prompt.WriteString("The following skills provide specialized instructions for specific tasks.\n")
	prompt.WriteString("When a task matches a skill's description, use the read tool to load its SKILL.md before proceeding.\n")
	prompt.WriteString("Resolve relative paths in a skill against the directory containing its SKILL.md, and use absolute paths in tool calls.\n\n")
	prompt.WriteString("<available_skills>\n")
	for _, skill := range available {
		prompt.WriteString("  <skill>\n")
		prompt.WriteString("    <name>")
		prompt.WriteString(html.EscapeString(skill.Name))
		prompt.WriteString("</name>\n")
		prompt.WriteString("    <description>")
		prompt.WriteString(html.EscapeString(skill.Description))
		prompt.WriteString("</description>\n")
		prompt.WriteString("    <location>")
		prompt.WriteString(html.EscapeString(skill.Location))
		prompt.WriteString("</location>\n")
		prompt.WriteString("  </skill>\n")
	}
	prompt.WriteString("</available_skills>")
	return prompt.String()
}
