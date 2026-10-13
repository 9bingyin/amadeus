package tool

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/felinics/twilight/sdk"
	"github.com/google/jsonschema-go/jsonschema"
)

type Context struct {
	context.Context
	ToolCallID   string
	ToolName     string
	SendProgress func(any)
}

type ExecuteFunc func(*Context, any) (any, error)

type Tool struct {
	Name        string             `json:"name"`
	Description string             `json:"description,omitempty"`
	Parameters  *jsonschema.Schema `json:"parameters"`
	Execute     ExecuteFunc        `json:"-"`
}

func (t Tool) Definition() sdk.ToolDefinition {
	return sdk.ToolDefinition{Name: t.Name, Description: t.Description, Parameters: t.Parameters}
}

func New[T any](name, description string, execute func(*Context, T) (any, error)) Tool {
	definition, err := sdk.NewToolDefinition[T](name, description)
	if err != nil {
		panic(err)
	}
	return Tool{
		Name: definition.Name, Description: definition.Description, Parameters: definition.Parameters,
		Execute: func(ctx *Context, input any) (any, error) {
			encoded, err := json.Marshal(input)
			if err != nil {
				return nil, fmt.Errorf("encode %s arguments: %w", name, err)
			}
			var typed T
			if err := json.Unmarshal(encoded, &typed); err != nil {
				return nil, fmt.Errorf("decode %s arguments: %w", name, err)
			}
			return execute(ctx, typed)
		},
	}
}

func Output(value any) (sdk.ToolOutput, error) {
	if text, ok := value.(string); ok {
		return sdk.TextOutput(text), nil
	}
	return sdk.JSONOutput(value)
}
