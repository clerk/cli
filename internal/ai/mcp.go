package ai

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"
	"sync/atomic"
)

// MCPClient manages a connection to a single MCP server over stdio.
type MCPClient struct {
	name    string
	command string
	args    []string
	env     map[string]string

	cmd    *exec.Cmd
	stdin  io.WriteCloser
	reader *bufio.Reader
	mu     sync.Mutex
	nextID atomic.Int64
}

// MCPTool represents a tool exposed by an MCP server.
type MCPTool struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"inputSchema"`
}

// JSON-RPC 2.0 types

type jsonRPCRequest struct {
	JSONRPC string      `json:"jsonrpc"`
	ID      *int64      `json:"id,omitempty"` // nil for notifications
	Method  string      `json:"method"`
	Params  interface{} `json:"params,omitempty"`
}

type jsonRPCResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      *int64          `json:"id,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *jsonRPCError   `json:"error,omitempty"`
}

type jsonRPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// MCP-specific types

type mcpInitializeParams struct {
	ProtocolVersion string            `json:"protocolVersion"`
	Capabilities    mcpCapabilities   `json:"capabilities"`
	ClientInfo      mcpImplementation `json:"clientInfo"`
}

type mcpCapabilities struct{}

type mcpImplementation struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

type mcpToolsListResult struct {
	Tools []MCPTool `json:"tools"`
}

type mcpToolCallParams struct {
	Name      string                 `json:"name"`
	Arguments map[string]interface{} `json:"arguments,omitempty"`
}

type mcpToolCallResult struct {
	Content []mcpContent `json:"content"`
	IsError bool         `json:"isError,omitempty"`
}

type mcpContent struct {
	Type string `json:"type"`
	Text string `json:"text,omitempty"`
}

// NewMCPClient creates a new MCP client for the given server.
func NewMCPClient(name, command string, args []string, env map[string]string) *MCPClient {
	return &MCPClient{
		name:    name,
		command: command,
		args:    args,
		env:     env,
	}
}

// Start spawns the MCP server process and performs the initialization handshake.
func (c *MCPClient) Start() error {
	c.cmd = exec.Command(c.command, c.args...) // #nosec G204 -- MCP command is from user config

	// Inherit current environment and add configured env vars
	c.cmd.Env = os.Environ()
	for k, v := range c.env {
		c.cmd.Env = append(c.cmd.Env, k+"="+v)
	}

	// Set up stderr to discard (or could pipe to debug log)
	c.cmd.Stderr = io.Discard

	stdin, err := c.cmd.StdinPipe()
	if err != nil {
		return fmt.Errorf("mcp server %s: failed to create stdin pipe: %w", c.name, err)
	}
	c.stdin = stdin

	stdout, err := c.cmd.StdoutPipe()
	if err != nil {
		return fmt.Errorf("mcp server %s: failed to create stdout pipe: %w", c.name, err)
	}
	c.reader = bufio.NewReader(stdout)

	if err := c.cmd.Start(); err != nil {
		return fmt.Errorf("mcp server %s: failed to start: %w", c.name, err)
	}

	// Send initialize request
	_, err = c.call("initialize", mcpInitializeParams{
		ProtocolVersion: "2024-11-05",
		Capabilities:    mcpCapabilities{},
		ClientInfo: mcpImplementation{
			Name:    "clerk-cli",
			Version: "1.0.0",
		},
	})
	if err != nil {
		c.Close()
		return fmt.Errorf("mcp server %s: initialization failed: %w", c.name, err)
	}

	// Send initialized notification (no ID = notification)
	if err := c.notify("notifications/initialized", nil); err != nil {
		c.Close()
		return fmt.Errorf("mcp server %s: initialized notification failed: %w", c.name, err)
	}

	return nil
}

// ListTools returns the tools available from this MCP server.
func (c *MCPClient) ListTools() ([]MCPTool, error) {
	result, err := c.call("tools/list", nil)
	if err != nil {
		return nil, fmt.Errorf("mcp server %s: tools/list failed: %w", c.name, err)
	}

	var toolsResult mcpToolsListResult
	if err := json.Unmarshal(result, &toolsResult); err != nil {
		return nil, fmt.Errorf("mcp server %s: failed to parse tools: %w", c.name, err)
	}

	return toolsResult.Tools, nil
}

// CallTool invokes a tool on this MCP server and returns the text result.
func (c *MCPClient) CallTool(name string, arguments map[string]interface{}) (string, error) {
	result, err := c.call("tools/call", mcpToolCallParams{
		Name:      name,
		Arguments: arguments,
	})
	if err != nil {
		return "", fmt.Errorf("mcp server %s: tool call %s failed: %w", c.name, name, err)
	}

	var callResult mcpToolCallResult
	if err := json.Unmarshal(result, &callResult); err != nil {
		return "", fmt.Errorf("mcp server %s: failed to parse tool result: %w", c.name, err)
	}

	if callResult.IsError {
		for _, content := range callResult.Content {
			if content.Type == "text" {
				return "", fmt.Errorf("mcp tool %s error: %s", name, content.Text)
			}
		}
		return "", fmt.Errorf("mcp tool %s returned an error", name)
	}

	// Concatenate all text content
	var text string
	for _, content := range callResult.Content {
		if content.Type == "text" {
			if text != "" {
				text += "\n"
			}
			text += content.Text
		}
	}

	return text, nil
}

// Close terminates the MCP server process.
func (c *MCPClient) Close() error {
	if c.stdin != nil {
		c.stdin.Close()
	}
	if c.cmd != nil && c.cmd.Process != nil {
		c.cmd.Process.Kill()
		c.cmd.Wait()
	}
	return nil
}

// call sends a JSON-RPC request and waits for the response.
func (c *MCPClient) call(method string, params interface{}) (json.RawMessage, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	id := c.nextID.Add(1)
	req := jsonRPCRequest{
		JSONRPC: "2.0",
		ID:      &id,
		Method:  method,
		Params:  params,
	}

	data, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request: %w", err)
	}

	// Write request followed by newline
	if _, err := c.stdin.Write(append(data, '\n')); err != nil {
		return nil, fmt.Errorf("failed to write request: %w", err)
	}

	// Read response lines until we get one with a matching ID
	for {
		line, err := c.reader.ReadBytes('\n')
		if err != nil {
			return nil, fmt.Errorf("failed to read response: %w", err)
		}

		var resp jsonRPCResponse
		if err := json.Unmarshal(line, &resp); err != nil {
			// Skip lines that aren't valid JSON-RPC (e.g., log output)
			continue
		}

		// Skip notifications (no ID)
		if resp.ID == nil {
			continue
		}

		if *resp.ID != id {
			// Not our response, skip
			continue
		}

		if resp.Error != nil {
			return nil, fmt.Errorf("JSON-RPC error %d: %s", resp.Error.Code, resp.Error.Message)
		}

		return resp.Result, nil
	}
}

// notify sends a JSON-RPC notification (no response expected).
func (c *MCPClient) notify(method string, params interface{}) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	req := jsonRPCRequest{
		JSONRPC: "2.0",
		Method:  method,
		Params:  params,
	}

	data, err := json.Marshal(req)
	if err != nil {
		return fmt.Errorf("failed to marshal notification: %w", err)
	}

	if _, err := c.stdin.Write(append(data, '\n')); err != nil {
		return fmt.Errorf("failed to write notification: %w", err)
	}

	return nil
}
