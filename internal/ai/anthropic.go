package ai

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

type AnthropicProvider struct {
	apiKey string
	model  string
}

func NewAnthropicProvider(apiKey, model string) *AnthropicProvider {
	if model == "" {
		model = "claude-sonnet-4-20250514"
	}
	return &AnthropicProvider{
		apiKey: apiKey,
		model:  model,
	}
}

type anthropicRequest struct {
	Model     string             `json:"model"`
	MaxTokens int                `json:"max_tokens"`
	System    string             `json:"system,omitempty"`
	Messages  []anthropicMessage `json:"messages"`
	Tools     []anthropicTool    `json:"tools,omitempty"`
}

type anthropicMessage struct {
	Role    string      `json:"role"`
	Content interface{} `json:"content"` // string or []anthropicContentBlock
}

type anthropicContentBlock struct {
	Type      string          `json:"type"`
	Text      string          `json:"text,omitempty"`
	ID        string          `json:"id,omitempty"`
	Name      string          `json:"name,omitempty"`
	Input     json.RawMessage `json:"input,omitempty"`
	ToolUseID string          `json:"tool_use_id,omitempty"`
	Content   string          `json:"content,omitempty"`
	IsError   bool            `json:"is_error,omitempty"`
}

type anthropicTool struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"input_schema"`
}

type anthropicResponse struct {
	Content    []anthropicContentBlock `json:"content"`
	StopReason string                  `json:"stop_reason"`
	Error      *struct {
		Type    string `json:"type"`
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

func (p *AnthropicProvider) GenerateExpression(schema string, description string, tools *ToolManager) (string, error) {
	sysPrompt := systemPrompt
	if tools.HasTools() {
		sysPrompt += systemPromptToolsSuffix
	}

	userPrompt := fmt.Sprintf(`Schema for available fields:
%s

Generate a rule expression for: %s`, schema, description)

	messages := []anthropicMessage{
		{Role: "user", Content: userPrompt},
	}

	return p.chatWithTools(sysPrompt, messages, tools)
}

func (p *AnthropicProvider) ModifyExpression(schema string, currentExpression string, modification string, tools *ToolManager) (string, error) {
	sysPrompt := modifyPrompt
	if tools.HasTools() {
		sysPrompt += modifyPromptToolsSuffix
	}

	userPrompt := fmt.Sprintf(`Schema for available fields:
%s

Current expression:
%s

Modify the expression to: %s`, schema, currentExpression, modification)

	messages := []anthropicMessage{
		{Role: "user", Content: userPrompt},
	}

	return p.chatWithTools(sysPrompt, messages, tools)
}

func (p *AnthropicProvider) chatWithTools(sysPrompt string, messages []anthropicMessage, tools *ToolManager) (string, error) {
	// Convert tools to Anthropic format
	var anthropicTools []anthropicTool
	if tools.HasTools() {
		for _, t := range tools.GetTools() {
			anthropicTools = append(anthropicTools, anthropicTool{
				Name:        t.Name,
				Description: t.Description,
				InputSchema: t.InputSchema,
			})
		}
	}

	maxIterations := 10
	for i := 0; i < maxIterations; i++ {
		reqBody := anthropicRequest{
			Model:     p.model,
			MaxTokens: 4096,
			System:    sysPrompt,
			Messages:  messages,
			Tools:     anthropicTools,
		}

		resp, err := p.doRequest(reqBody)
		if err != nil {
			return "", err
		}

		// Check if we need to handle tool calls
		if resp.StopReason == "tool_use" {
			// Collect all tool use blocks and execute them
			var toolResults []anthropicContentBlock
			for _, block := range resp.Content {
				if block.Type == "tool_use" {
					var args map[string]interface{}
					if err := json.Unmarshal(block.Input, &args); err != nil {
						args = nil
					}

					if IsDebug() {
						fmt.Printf("[DEBUG] MCP tool call: %s(%s)\n", block.Name, string(block.Input))
					}

					result, callErr := tools.CallTool(block.Name, args)
					if callErr != nil {
						toolResults = append(toolResults, anthropicContentBlock{
							Type:      "tool_result",
							ToolUseID: block.ID,
							Content:   callErr.Error(),
							IsError:   true,
						})
					} else {
						if IsDebug() {
							fmt.Printf("[DEBUG] MCP tool result: %s\n", truncateForDebug(result, 200))
						}
						toolResults = append(toolResults, anthropicContentBlock{
							Type:      "tool_result",
							ToolUseID: block.ID,
							Content:   result,
						})
					}
				}
			}

			// Add assistant response and tool results to conversation
			messages = append(messages, anthropicMessage{
				Role:    "assistant",
				Content: resp.Content,
			})
			messages = append(messages, anthropicMessage{
				Role:    "user",
				Content: toolResults,
			})
			continue
		}

		// No more tool calls — extract text response
		return p.extractText(resp)
	}

	return "", fmt.Errorf("too many tool call iterations")
}

func (p *AnthropicProvider) doRequest(reqBody anthropicRequest) (*anthropicResponse, error) {
	jsonBody, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request: %w", err)
	}

	req, err := http.NewRequest("POST", "https://api.anthropic.com/v1/messages", bytes.NewReader(jsonBody))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-api-key", p.apiKey)
	req.Header.Set("anthropic-version", "2023-06-01")

	if IsDebug() {
		fmt.Printf("[DEBUG] --> POST https://api.anthropic.com/v1/messages\n")
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to make request: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}

	var result anthropicResponse
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, fmt.Errorf("failed to parse response: %w", err)
	}

	if result.Error != nil {
		return nil, fmt.Errorf("Anthropic error: %s", result.Error.Message)
	}

	return &result, nil
}

func (p *AnthropicProvider) extractText(resp *anthropicResponse) (string, error) {
	if len(resp.Content) == 0 {
		return "", fmt.Errorf("no response from Anthropic")
	}

	expression := ""
	for _, c := range resp.Content {
		if c.Type == "text" {
			expression = c.Text
			break
		}
	}

	expression = strings.TrimSpace(expression)
	// Remove markdown code blocks if present
	expression = strings.TrimPrefix(expression, "```")
	expression = strings.TrimSuffix(expression, "```")
	expression = strings.TrimSpace(expression)

	return expression, nil
}

func truncateForDebug(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "..."
}
