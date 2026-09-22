package mcp

import (
	"encoding/json"
	"fmt"
	"maps"
	"slices"
	"strconv"
	"strings"

	"github.com/felinics/twilight/sdk"
	"github.com/google/jsonschema-go/jsonschema"
)

const (
	toolsListText  = "List hidden MCP servers. Omit server to list server names. Pass a server name to list that server's tools and argument fields, then pass one of those names to tool_call."
	toolCallText   = "Call an MCP tool by the name returned from tools_list. arguments is a JSON object matching that result. The MCP server validates the arguments."
	schemaDepthMax = 8
)

type mcpTool struct {
	server      string
	name        string
	description string
	parameters  any
	execute     sdk.ToolExecuteFunc
}

type toolsListInput struct {
	Server string `json:"server,omitempty" jsonschema:"MCP server name. Omit to list server names."`
}

type toolCallInput struct {
	Name      string         `json:"name" jsonschema:"MCP tool name returned by tools_list"`
	Arguments map[string]any `json:"arguments,omitempty" jsonschema:"JSON object of arguments for that tool"`
}

func (d DirectTools) exposes(original, safe string) bool {
	if d.All {
		return true
	}
	return matchesAny(d.Names, original, safe)
}

func toolAllowed(original, safe string, include, exclude []string) bool {
	if len(include) > 0 && !matchesAny(include, original, safe) {
		return false
	}
	return !matchesAny(exclude, original, safe)
}

func matchesAny(patterns []string, names ...string) bool {
	for _, pattern := range patterns {
		for _, name := range names {
			if matchGlob(pattern, name) {
				return true
			}
		}
	}
	return false
}

func matchGlob(pattern, value string) bool {
	parts := strings.Split(pattern, "*")
	if len(parts) == 1 {
		return pattern == value
	}
	if !strings.HasPrefix(value, parts[0]) {
		return false
	}
	value = value[len(parts[0]):]
	for _, part := range parts[1 : len(parts)-1] {
		if part == "" {
			continue
		}
		index := strings.Index(value, part)
		if index < 0 {
			return false
		}
		value = value[index+len(part):]
	}
	last := parts[len(parts)-1]
	if last == "" {
		return true
	}
	return strings.HasSuffix(value, last)
}

func (s *Set) listTool() sdk.Tool {
	return sdk.NewTool("tools_list", toolsListText, func(_ *sdk.ToolExecContext, input toolsListInput) (any, error) {
		return s.list(input.Server)
	})
}

func (s *Set) callTool() sdk.Tool {
	return sdk.NewTool("tool_call", toolCallText, func(ctx *sdk.ToolExecContext, input toolCallInput) (any, error) {
		return s.call(ctx, input)
	})
}

func (s *Set) list(server string) (string, error) {
	server = strings.TrimSpace(server)
	if server == "" {
		return formatServerList(s.hidden), nil
	}
	matches := make([]mcpTool, 0)
	for _, tool := range s.hidden {
		if tool.server == server {
			matches = append(matches, tool)
		}
	}
	if len(matches) == 0 {
		return "", fmt.Errorf("unknown MCP server %q", server)
	}
	slices.SortFunc(matches, func(left, right mcpTool) int {
		return strings.Compare(left.name, right.name)
	})
	return formatToolList(matches), nil
}

func formatServerList(tools []mcpTool) string {
	seen := make(map[string]struct{})
	names := make([]string, 0)
	for _, tool := range tools {
		if _, ok := seen[tool.server]; ok {
			continue
		}
		seen[tool.server] = struct{}{}
		names = append(names, tool.server)
	}
	slices.Sort(names)
	return strings.Join(names, "\n")
}

func (s *Set) call(ctx *sdk.ToolExecContext, input toolCallInput) (any, error) {
	name := strings.TrimSpace(input.Name)
	tool, ok := s.callable[name]
	if !ok || tool.execute == nil {
		return nil, fmt.Errorf("unknown MCP tool %q", name)
	}
	arguments := input.Arguments
	if arguments == nil {
		arguments = map[string]any{}
	}
	return tool.execute(ctx, arguments)
}

func formatToolList(matches []mcpTool) string {
	var text strings.Builder
	for index, tool := range matches {
		if index > 0 {
			text.WriteString("\n")
		}
		text.WriteString(tool.name)
		text.WriteByte('\n')
		if description := strings.TrimSpace(tool.description); description != "" {
			text.WriteString(description)
			text.WriteByte('\n')
		}
		if arguments := formatArguments(tool.parameters); arguments != "" {
			text.WriteByte('\n')
			text.WriteString(arguments)
			if !strings.HasSuffix(arguments, "\n") {
				text.WriteByte('\n')
			}
		}
	}
	return strings.TrimRight(text.String(), "\n")
}

func formatArguments(parameters any) string {
	schema, ok := schemaFrom(parameters)
	if !ok || schema == nil || len(schema.Properties) == 0 {
		return ""
	}
	var text strings.Builder
	text.WriteString("arguments:\n")
	writeProperties(&text, schema, "  ", 0)
	return strings.TrimRight(text.String(), "\n")
}

func writeProperties(text *strings.Builder, schema *jsonschema.Schema, indent string, depth int) {
	names := slices.Sorted(maps.Keys(schema.Properties))
	required := map[string]struct{}{}
	for _, name := range schema.Required {
		required[name] = struct{}{}
	}
	slices.SortStableFunc(names, func(left, right string) int {
		_, leftRequired := required[left]
		_, rightRequired := required[right]
		if leftRequired != rightRequired {
			if leftRequired {
				return -1
			}
			return 1
		}
		return strings.Compare(left, right)
	})
	for _, name := range names {
		property := schema.Properties[name]
		if property == nil {
			continue
		}
		fmt.Fprintf(text, "%s%s: %s", indent, name, typeLabel(property))
		if _, ok := required[name]; ok {
			text.WriteString(", required")
		}
		if description := oneLine(property.Description); description != "" {
			text.WriteString(" — ")
			text.WriteString(description)
		}
		text.WriteByte('\n')
		if depth < schemaDepthMax && len(property.Properties) > 0 {
			writeProperties(text, property, indent+"  ", depth+1)
		}
	}
}

func typeLabel(schema *jsonschema.Schema) string {
	if schema == nil {
		return "any"
	}
	if len(schema.Enum) > 0 {
		labels := make([]string, len(schema.Enum))
		for index, value := range schema.Enum {
			labels[index] = enumLabel(value)
		}
		return strings.Join(labels, " | ")
	}
	kind := schema.Type
	if kind == "" && len(schema.Types) > 0 {
		kind = strings.Join(schema.Types, " | ")
	}
	switch kind {
	case "":
		if len(schema.Properties) > 0 {
			return "object"
		}
		return "any"
	case "array":
		item := "any"
		if schema.Items != nil {
			item = typeLabel(schema.Items)
		}
		return item + "[]"
	case "integer":
		return "number"
	default:
		return kind
	}
}

func enumLabel(value any) string {
	switch typed := value.(type) {
	case string:
		return strconv.Quote(typed)
	default:
		return fmt.Sprint(typed)
	}
}

func oneLine(value string) string {
	return strings.Join(strings.Fields(value), " ")
}

func schemaFrom(parameters any) (*jsonschema.Schema, bool) {
	switch value := parameters.(type) {
	case nil:
		return nil, false
	case *jsonschema.Schema:
		return value, true
	case jsonschema.Schema:
		return &value, true
	default:
		data, err := json.Marshal(value)
		if err != nil {
			return nil, false
		}
		var schema jsonschema.Schema
		if err := json.Unmarshal(data, &schema); err != nil {
			return nil, false
		}
		return &schema, true
	}
}
