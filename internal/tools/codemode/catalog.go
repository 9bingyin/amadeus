package codemode

import (
	"cmp"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"slices"
	"strings"
	"unicode"

	toolkit "github.com/9bingyin/amadeus/internal/tools/tool"
	quickjs "github.com/MichaelKinsy/PiG/codemode"
)

type catalogEntry struct {
	binding   quickjs.Tool
	namespace string
	terms     map[string]int
	length    int
}

type catalog struct {
	entries []catalogEntry
}

type toolInfo struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}

func newCatalog(tools []toolkit.Tool) (*catalog, error) {
	catalog := &catalog{}
	names := map[string]string{}
	for _, tool := range tools {
		name := quickjs.ToCodemodeIdentifier(tool.Name)
		if strings.TrimSpace(tool.Name) == "" || tool.Name == "codemode" {
			return nil, fmt.Errorf("invalid codemode callable tool %q", tool.Name)
		}
		if previous, found := names[name]; found {
			return nil, fmt.Errorf("codemode identifier %q conflicts between %q and %q", name, previous, tool.Name)
		}
		names[name] = tool.Name
		schema, err := json.Marshal(tool.Parameters)
		if err != nil {
			return nil, fmt.Errorf("encode %s schema: %w", tool.Name, err)
		}
		binding := quickjs.Tool{Name: tool.Name, Description: tool.Description, InputSchema: schema}
		if tool.Namespace != "" {
			binding.OutputSchema = json.RawMessage(`{"type":"object","properties":{"content":{"type":"array","items":{"type":"object"}},"isError":{"type":"boolean"},"structuredContent":true,"_meta":{"type":"object"}}}`)
		}
		binding.Description = quickjs.RenderToolSample(binding, 0)
		terms := tokenize(tool.Name + " " + tool.Namespace + " " + tool.Description + " " + string(schema))
		frequencies := map[string]int{}
		for _, term := range terms {
			frequencies[term]++
		}
		catalog.entries = append(catalog.entries, catalogEntry{
			binding: binding, namespace: tool.Namespace, terms: frequencies, length: len(terms),
		})
	}
	return catalog, nil
}

func ScriptCallDescription(tool toolkit.Tool) string {
	return fmt.Sprintf("%s\n\nCodemode: `tools.%s(args)`.", strings.TrimSpace(tool.Description), quickjs.ToCodemodeIdentifier(tool.Name))
}

func (c *catalog) globals() []quickjs.Tool {
	return []quickjs.Tool{
		{Name: "searchTools", Spread: true, Execute: func(_ context.Context, raw json.RawMessage) (json.RawMessage, error) {
			var args []json.RawMessage
			if err := json.Unmarshal(raw, &args); err != nil {
				return nil, fmt.Errorf("searchTools arguments: %w", err)
			}
			if len(args) == 0 {
				return nil, fmt.Errorf("searchTools requires a query")
			}
			var query string
			if err := json.Unmarshal(args[0], &query); err != nil {
				return nil, fmt.Errorf("searchTools query: %w", err)
			}
			options := struct {
				Limit     int    `json:"limit"`
				Namespace string `json:"namespace"`
			}{Limit: 8}
			if len(args) > 1 {
				if err := json.Unmarshal(args[1], &options); err != nil {
					return nil, fmt.Errorf("searchTools options: %w", err)
				}
			}
			if options.Limit < 0 {
				return nil, fmt.Errorf("searchTools limit must be non-negative")
			}
			return json.Marshal(c.search(query, options.Limit, options.Namespace))
		}},
		{Name: "describeTool", Execute: func(_ context.Context, raw json.RawMessage) (json.RawMessage, error) {
			var name string
			if err := json.Unmarshal(raw, &name); err != nil {
				return nil, fmt.Errorf("describeTool name: %w", err)
			}
			for _, entry := range c.entries {
				if entry.binding.Name == name || quickjs.ToCodemodeIdentifier(entry.binding.Name) == name {
					declaration := quickjs.RenderDeclarations(quickjs.RenderDeclarationsOptions{Tools: []quickjs.Tool{entry.binding}})
					if entry.namespace != "" {
						declaration = quickjs.McpTypescriptPreamble + "\n" + declaration
					}
					return json.Marshal(struct {
						toolInfo
						Declaration string `json:"declaration"`
					}{info(entry), declaration})
				}
			}
			return nil, nil
		}},
		{Name: "describeNamespace", Execute: func(_ context.Context, raw json.RawMessage) (json.RawMessage, error) {
			var name string
			if err := json.Unmarshal(raw, &name); err != nil {
				return nil, fmt.Errorf("describeNamespace name: %w", err)
			}
			tools := []toolInfo{}
			for _, entry := range c.entries {
				if entry.namespace == name {
					tools = append(tools, info(entry))
				}
			}
			if len(tools) == 0 {
				return nil, nil
			}
			return json.Marshal(struct {
				Name  string     `json:"name"`
				Tools []toolInfo `json:"tools"`
			}{name, tools})
		}},
	}
}

func info(entry catalogEntry) toolInfo {
	return toolInfo{Name: quickjs.ToCodemodeIdentifier(entry.binding.Name), Description: entry.binding.Description}
}

func (c *catalog) search(query string, limit int, namespace string) []toolInfo {
	terms := tokenize(query)
	slices.Sort(terms)
	terms = slices.Compact(terms)
	averageLength := 0.0
	frequency := map[string]int{}
	for _, entry := range c.entries {
		averageLength += float64(entry.length)
		for _, term := range terms {
			if entry.terms[term] > 0 {
				frequency[term]++
			}
		}
	}
	averageLength /= float64(max(1, len(c.entries)))
	averageLength = max(1, averageLength)
	type match struct {
		entry catalogEntry
		score float64
	}
	matches := []match{}
	for _, entry := range c.entries {
		if namespace != "" && entry.namespace != namespace {
			continue
		}
		score := 0.0
		for _, term := range terms {
			count := float64(entry.terms[term])
			if count == 0 {
				continue
			}
			idf := math.Log(1 + (float64(len(c.entries)-frequency[term])+0.5)/(float64(frequency[term])+0.5))
			score += idf * count * 2.2 / (count + 1.2*(0.25+0.75*float64(entry.length)/averageLength))
		}
		if score > 0 || len(terms) == 0 {
			matches = append(matches, match{entry, score})
		}
	}
	slices.SortStableFunc(matches, func(left, right match) int {
		return cmp.Compare(right.score, left.score)
	})
	output := make([]toolInfo, min(limit, len(matches)))
	for index := range output {
		output[index] = info(matches[index].entry)
	}
	return output
}

func tokenize(text string) []string {
	return strings.FieldsFunc(strings.ToLower(text), func(character rune) bool {
		return !unicode.IsLetter(character) && !unicode.IsDigit(character)
	})
}
