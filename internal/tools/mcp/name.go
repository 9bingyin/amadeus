package mcp

import (
	"fmt"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

const (
	mcpNameSeparator = "__"
	mcpServerMax     = 30
	mcpNameMax       = 64
	mcpNameAttempts  = 1000
)

func safeMCPToolName(serverName, toolName string, used map[string]string) (string, error) {
	server := sanitizeMCPFragment(serverName, "mcp", mcpServerMax)
	maxTool := mcpNameMax - len(server) - len(mcpNameSeparator)
	if maxTool < 1 {
		return "", fmt.Errorf("MCP server name %q is too long", serverName)
	}
	tool := sanitizeMCPFragment(toolName, "tool", 0)
	if len(tool) > maxTool {
		tool = trimMCPFragment(tool[:maxTool])
	}
	candidate := server + mcpNameSeparator + tool
	for attempt := 1; attempt <= mcpNameAttempts; attempt++ {
		if _, exists := used[candidate]; !exists {
			return candidate, nil
		}
		suffix := "-" + strconv.Itoa(attempt+1)
		if len(suffix) >= maxTool {
			break
		}
		base := tool
		if len(base)+len(suffix) > maxTool {
			base = trimMCPFragment(base[:maxTool-len(suffix)])
		}
		candidate = server + mcpNameSeparator + base + suffix
	}
	return "", fmt.Errorf("MCP tool %q from server %q has no available name", toolName, serverName)
}

func sanitizeMCPFragment(raw, fallback string, maxChars int) string {
	var builder strings.Builder
	for _, char := range strings.TrimSpace(raw) {
		if char <= unicode.MaxASCII && (isASCIILetter(byte(char)) || isASCIIDigit(byte(char)) || char == '_' || char == '-') {
			builder.WriteRune(char)
			continue
		}
		builder.WriteByte('-')
	}
	normalized := builder.String()
	if normalized == "" {
		normalized = fallback
	}
	if !startsWithLetter(normalized) {
		normalized = fallback + "-" + normalized
	}
	if maxChars > 0 && len(normalized) > maxChars {
		normalized = trimMCPFragment(normalized[:maxChars])
		if normalized == "" || !startsWithLetter(normalized) {
			normalized = fallback
			if len(normalized) > maxChars {
				normalized = normalized[:maxChars]
			}
		}
	}
	return normalized
}

func trimMCPFragment(value string) string {
	return strings.TrimRight(value, "-_")
}

func startsWithLetter(value string) bool {
	char, _ := utf8.DecodeRuneInString(value)
	return char <= unicode.MaxASCII && isASCIILetter(byte(char))
}

func isASCIILetter(char byte) bool {
	return (char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z')
}

func isASCIIDigit(char byte) bool {
	return char >= '0' && char <= '9'
}
