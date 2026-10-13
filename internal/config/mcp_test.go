package config

import (
	"strings"
	"testing"
)

func TestLoadRejectsDirectTools(t *testing.T) {
	for _, value := range []string{"true", "false", "null", `[]`, `["search"]`, `"search"`} {
		for _, level := range []string{"global", "server"} {
			t.Run(level+"/"+value, func(t *testing.T) {
				mcp := `{"directTools":` + value + `}`
				if level == "server" {
					mcp = `{"servers":[{"name":"github","transport":"stdio","command":"server","directTools":` + value + `}]}`
				}
				path := writeConfig(t, `{
					"models":{"assistant":{"provider":"gateway","id":"model"}},
					"model":"assistant",
					"providers":{"gateway":{"api":"openai-responses","apiKey":"key"}},
					"telegram":{"enabled":true},"mcp":`+mcp+`}`)
				if _, err := Load(path); err == nil || !strings.Contains(err.Error(), `unknown field "directTools"`) {
					t.Fatalf("Load() error = %v, want unknown directTools field", err)
				}
			})
		}
	}
}
