package ai

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

type OpenAIProvider struct {
	apiKey string
	model  string
}

func NewOpenAIProvider(apiKey, model string) *OpenAIProvider {
	if model == "" {
		model = "gpt-4o"
	}
	return &OpenAIProvider{
		apiKey: apiKey,
		model:  model,
	}
}

type openAIRequest struct {
	Model    string          `json:"model"`
	Messages []openAIMessage `json:"messages"`
	Tools    []openAITool    `json:"tools,omitempty"`
}

type openAIMessage struct {
	Role       string          `json:"role"`
	Content    *string         `json:"content,omitempty"`
	ToolCalls  []openAIToolCall `json:"tool_calls,omitempty"`
	ToolCallID string          `json:"tool_call_id,omitempty"`
}

type openAITool struct {
	Type     string         `json:"type"`
	Function openAIFunction `json:"function"`
}

type openAIFunction struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Parameters  json.RawMessage `json:"parameters"`
}

type openAIToolCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

type openAIResponse struct {
	Choices []struct {
		Message struct {
			Content   *string          `json:"content"`
			ToolCalls []openAIToolCall  `json:"tool_calls,omitempty"`
		} `json:"message"`
		FinishReason string `json:"finish_reason"`
	} `json:"choices"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

func strPtr(s string) *string { return &s }

func (p *OpenAIProvider) GenerateExpression(schema string, description string, tools *ToolManager) (string, error) {
	sysPrompt := systemPrompt
	if tools.HasTools() {
		sysPrompt += systemPromptToolsSuffix
	}

	userPrompt := fmt.Sprintf(`Schema for available fields:
%s

Generate a rule expression for: %s`, schema, description)

	messages := []openAIMessage{
		{Role: "system", Content: strPtr(sysPrompt)},
		{Role: "user", Content: strPtr(userPrompt)},
	}

	return p.chatWithTools(messages, tools)
}

func (p *OpenAIProvider) ModifyExpression(schema string, currentExpression string, modification string, tools *ToolManager) (string, error) {
	sysPrompt := modifyPrompt
	if tools.HasTools() {
		sysPrompt += modifyPromptToolsSuffix
	}

	userPrompt := fmt.Sprintf(`Schema for available fields:
%s

Current expression:
%s

Modify the expression to: %s`, schema, currentExpression, modification)

	messages := []openAIMessage{
		{Role: "system", Content: strPtr(sysPrompt)},
		{Role: "user", Content: strPtr(userPrompt)},
	}

	return p.chatWithTools(messages, tools)
}

func (p *OpenAIProvider) chatWithTools(messages []openAIMessage, tools *ToolManager) (string, error) {
	// Convert tools to OpenAI format
	var openaiTools []openAITool
	if tools.HasTools() {
		for _, t := range tools.GetTools() {
			openaiTools = append(openaiTools, openAITool{
				Type: "function",
				Function: openAIFunction{
					Name:        t.Name,
					Description: t.Description,
					Parameters:  t.InputSchema,
				},
			})
		}
	}

	maxIterations := 10
	for i := 0; i < maxIterations; i++ {
		reqBody := openAIRequest{
			Model:    p.model,
			Messages: messages,
			Tools:    openaiTools,
		}

		resp, err := p.doRequest(reqBody)
		if err != nil {
			return "", err
		}

		if len(resp.Choices) == 0 {
			return "", fmt.Errorf("no response from OpenAI")
		}

		choice := resp.Choices[0]

		// Check if we need to handle tool calls
		if len(choice.Message.ToolCalls) > 0 {
			// Add assistant message with tool calls
			messages = append(messages, openAIMessage{
				Role:      "assistant",
				ToolCalls: choice.Message.ToolCalls,
			})

			// Execute each tool call and add results
			for _, tc := range choice.Message.ToolCalls {
				var args map[string]interface{}
				if err := json.Unmarshal([]byte(tc.Function.Arguments), &args); err != nil {
					args = nil
				}

				if IsDebug() {
					fmt.Printf("[DEBUG] MCP tool call: %s(%s)\n", tc.Function.Name, tc.Function.Arguments)
				}

				result, callErr := tools.CallTool(tc.Function.Name, args)
				content := result
				if callErr != nil {
					content = "Error: " + callErr.Error()
				}

				if IsDebug() {
					fmt.Printf("[DEBUG] MCP tool result: %s\n", truncateForDebug(content, 200))
				}

				messages = append(messages, openAIMessage{
					Role:       "tool",
					Content:    strPtr(content),
					ToolCallID: tc.ID,
				})
			}
			continue
		}

		// No tool calls — extract final text
		if choice.Message.Content == nil {
			return "", fmt.Errorf("no text content in response")
		}

		expression := strings.TrimSpace(*choice.Message.Content)
		expression = strings.TrimPrefix(expression, "```")
		expression = strings.TrimSuffix(expression, "```")
		expression = strings.TrimSpace(expression)

		return expression, nil
	}

	return "", fmt.Errorf("too many tool call iterations")
}

func (p *OpenAIProvider) doRequest(reqBody openAIRequest) (*openAIResponse, error) {
	jsonBody, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request: %w", err)
	}

	req, err := http.NewRequest("POST", "https://api.openai.com/v1/chat/completions", bytes.NewReader(jsonBody))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+p.apiKey)

	if IsDebug() {
		fmt.Printf("[DEBUG] --> POST https://api.openai.com/v1/chat/completions\n")
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

	var result openAIResponse
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, fmt.Errorf("failed to parse response: %w", err)
	}

	if result.Error != nil {
		return nil, fmt.Errorf("OpenAI error: %s", result.Error.Message)
	}

	return &result, nil
}
