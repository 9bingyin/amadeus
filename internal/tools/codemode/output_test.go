package codemode

import (
	"encoding/json"
	"strings"
	"testing"

	quickjs "github.com/MichaelKinsy/PiG/codemode"
)

func TestFormatResultPreservesReturnTypes(t *testing.T) {
	for _, test := range []struct {
		value string
		want  string
	}{
		{`null`, "null"},
		{`false`, "false"},
		{`0`, "0"},
		{`"text"`, "text"},
		{`{"answer":42}`, `{"answer":42}`},
	} {
		t.Run(test.value, func(t *testing.T) {
			result, err := formatResult(quickjs.Result{OK: true, Value: json.RawMessage(test.value)}, 0, nil)
			if err != nil || result.IsError || !strings.HasSuffix(result.Text, "\n"+test.want) {
				t.Fatalf("result = %#v, %v", result, err)
			}
		})
	}
}
