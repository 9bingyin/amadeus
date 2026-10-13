package mcp

import (
	"context"
	"encoding/json"
	"fmt"

	toolkit "github.com/9bingyin/amadeus/internal/tools/tool"
	"github.com/google/jsonschema-go/jsonschema"
	mcpsdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

type connectionConfig struct {
	Transport mcpsdk.Transport
	Name      string
}

type sessionClient struct {
	session *mcpsdk.ClientSession
}

func createClient(ctx context.Context, config *connectionConfig) (client, error) {
	name := config.Name
	if name == "" {
		name = "amadeus"
	}
	client := mcpsdk.NewClient(&mcpsdk.Implementation{Name: name, Version: "v1.0.0"}, nil)
	session, err := client.Connect(ctx, config.Transport, nil)
	if err != nil {
		return nil, fmt.Errorf("connect MCP client: %w", err)
	}
	return &sessionClient{session: session}, nil
}

func (c *sessionClient) Close() error {
	return c.session.Close()
}

func (c *sessionClient) Tools(ctx context.Context) ([]toolkit.Tool, error) {
	var tools []toolkit.Tool
	params := &mcpsdk.ListToolsParams{}
	for {
		result, err := c.session.ListTools(ctx, params)
		if err != nil {
			return nil, fmt.Errorf("list MCP tools: %w", err)
		}
		for _, remote := range result.Tools {
			schema, err := mcpInputSchema(remote.InputSchema)
			if err != nil {
				return nil, fmt.Errorf("decode MCP tool %q schema: %w", remote.Name, err)
			}
			name := remote.Name
			tools = append(tools, toolkit.Tool{
				Name: name, Description: remote.Description, Parameters: schema,
				Execute: func(ctx *toolkit.Context, input any) (any, error) {
					result, err := c.session.CallTool(toolContext(ctx), &mcpsdk.CallToolParams{Name: name, Arguments: input})
					if err != nil {
						return nil, fmt.Errorf("call MCP tool %q: %w", name, err)
					}
					return result, nil
				},
			})
		}
		if result.NextCursor == "" {
			return tools, nil
		}
		params.Cursor = result.NextCursor
	}
}

func mcpInputSchema(value any) (*jsonschema.Schema, error) {
	if value == nil {
		return nil, nil
	}
	if schema, ok := value.(*jsonschema.Schema); ok {
		return schema, nil
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return nil, fmt.Errorf("encode input schema: %w", err)
	}
	var schema jsonschema.Schema
	if err := json.Unmarshal(raw, &schema); err != nil {
		return nil, fmt.Errorf("decode input schema: %w", err)
	}
	return &schema, nil
}
