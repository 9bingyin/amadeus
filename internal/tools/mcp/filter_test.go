package mcp

import (
	"context"
	"reflect"
	"slices"
	"testing"

	toolkit "github.com/9bingyin/amadeus/internal/tools/tool"
)

func TestLoadAllowedToolsAndNamespaces(t *testing.T) {
	local := toolkit.Tool{Name: "read", Description: "local"}
	set, err := load(t.Context(), t.TempDir(), []Server{{
		Name: "12306.docs", Transport: "http", URL: "https://example.com",
		IncludeTools: []string{"search_*", "mcp-12306-docs__get-*"},
		ExcludeTools: []string{"search_private", "mcp-12306-docs__get-secret"},
	}}, []toolkit.Tool{local}, func(context.Context, *connectionConfig) (client, error) {
		return &fakeClient{tools: []toolkit.Tool{
			{Name: "search_public"}, {Name: "search_private"}, {Name: "get-file"},
			{Name: "get-secret"}, {Name: "delete"},
		}}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := set.Close(); err != nil {
			t.Error(err)
		}
	})
	want := []string{"mcp-12306-docs__get-file", "mcp-12306-docs__search_public"}
	if got := toolNames(set.MCPTools()); !slices.Equal(got, want) {
		t.Fatalf("MCPTools() = %v, want %v", got, want)
	}
	if got := toolNames(set.Tools()); !slices.Equal(got, append(slices.Clone(want), "read")) {
		t.Fatalf("Tools() = %v", got)
	}
	for _, remote := range set.MCPTools() {
		if remote.Namespace != "12306.docs" {
			t.Fatalf("Namespace = %q", remote.Namespace)
		}
	}
	if got := set.Tools()[2]; !reflect.DeepEqual(got, local) {
		t.Fatalf("local tool changed: %#v", got)
	}
	copy := set.MCPTools()
	copy[0].Name = "changed"
	if !slices.Equal(toolNames(set.MCPTools()), want) {
		t.Fatal("MCPTools() exposed internal slice")
	}
	var empty *Set
	if empty.MCPTools() != nil {
		t.Fatal("nil MCPTools() must be nil")
	}
}

func TestMatchGlob(t *testing.T) {
	for _, test := range []struct {
		pattern, value string
		want           bool
	}{
		{"*", "anything", true}, {"search_*", "search_public", true},
		{"search_*", "get_public", false}, {"a*b*c", "a12b34c", true},
		{"a*b*c", "a12c34b", false}, {"a**c", "abc", true},
		{"exact", "exact", true}, {"exact", "exactly", false},
		{"*end", "ending", false},
	} {
		if got := matchGlob(test.pattern, test.value); got != test.want {
			t.Errorf("matchGlob(%q, %q) = %v", test.pattern, test.value, got)
		}
	}
}
