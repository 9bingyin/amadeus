package mcp

import "strings"

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
