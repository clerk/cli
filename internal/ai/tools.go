package ai

import (
	"encoding/json"
	"fmt"
)

// Tool is a provider-agnostic representation of an available tool.
type Tool struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"inputSchema"`
}

// ToolManager manages multiple MCP clients and routes tool calls.
type ToolManager struct {
	clients  []*MCPClient
	tools    []Tool
	toolMap  map[string]*MCPClient // tool name → owning client
}

// NewToolManager starts all configured MCP servers and collects their tools.
// Servers that fail to start are skipped with a warning printed to stderr.
func NewToolManager(servers map[string]MCPServerConfig) (*ToolManager, error) {
	if len(servers) == 0 {
		return nil, nil
	}

	tm := &ToolManager{
		toolMap: make(map[string]*MCPClient),
	}

	for name, cfg := range servers {
		client := NewMCPClient(name, cfg.Command, cfg.Args, cfg.Env)
		if err := client.Start(); err != nil {
			if IsDebug() {
				fmt.Printf("[DEBUG] MCP server %s failed to start: %v\n", name, err)
			}
			client.Close()
			continue
		}

		tools, err := client.ListTools()
		if err != nil {
			if IsDebug() {
				fmt.Printf("[DEBUG] MCP server %s failed to list tools: %v\n", name, err)
			}
			client.Close()
			continue
		}

		tm.clients = append(tm.clients, client)
		for _, t := range tools {
			tool := Tool{
				Name:        t.Name,
				Description: t.Description,
				InputSchema: t.InputSchema,
			}
			tm.tools = append(tm.tools, tool)
			tm.toolMap[t.Name] = client
		}
	}

	if len(tm.tools) == 0 {
		tm.Close()
		return nil, nil
	}

	return tm, nil
}

// GetTools returns all available tools across all MCP servers.
func (tm *ToolManager) GetTools() []Tool {
	if tm == nil {
		return nil
	}
	return tm.tools
}

// CallTool routes a tool call to the appropriate MCP server.
func (tm *ToolManager) CallTool(name string, arguments map[string]interface{}) (string, error) {
	if tm == nil {
		return "", fmt.Errorf("no tool manager available")
	}

	client, ok := tm.toolMap[name]
	if !ok {
		return "", fmt.Errorf("unknown tool: %s", name)
	}

	return client.CallTool(name, arguments)
}

// Close shuts down all MCP server processes.
func (tm *ToolManager) Close() {
	if tm == nil {
		return
	}
	for _, client := range tm.clients {
		client.Close()
	}
}

// HasTools returns true if there are any tools available.
func (tm *ToolManager) HasTools() bool {
	return tm != nil && len(tm.tools) > 0
}
