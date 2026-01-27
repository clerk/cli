package ai

import (
	"fmt"
	"os"

	"clerk.com/cli/internal/config"
)

// Provider represents an AI provider that can generate rule expressions
type Provider interface {
	GenerateExpression(schema string, description string) (string, error)
}

// Config holds AI configuration
type Config struct {
	Provider       string
	OpenAIKey      string
	OpenAIModel    string
	AnthropicKey   string
	AnthropicModel string
}

// GetConfig retrieves AI configuration from profile and environment
func GetConfig(profileName string) *Config {
	cfg := &Config{
		Provider:       config.ResolveValue("ai.provider", "", "", "", profileName),
		OpenAIKey:      config.ResolveValue("ai.openai.key", "", "OPENAI_API_KEY", "", profileName),
		OpenAIModel:    config.ResolveValue("ai.openai.model", "", "", "gpt-4o", profileName),
		AnthropicKey:   config.ResolveValue("ai.anthropic.key", "", "ANTHROPIC_API_KEY", "", profileName),
		AnthropicModel: config.ResolveValue("ai.anthropic.model", "", "", "claude-sonnet-4-20250514", profileName),
	}

	// Auto-detect provider if not set
	if cfg.Provider == "" {
		if cfg.OpenAIKey != "" {
			cfg.Provider = "openai"
		} else if cfg.AnthropicKey != "" {
			cfg.Provider = "anthropic"
		}
	}

	return cfg
}

// IsConfigured returns true if AI is configured
func (c *Config) IsConfigured() bool {
	switch c.Provider {
	case "openai":
		return c.OpenAIKey != ""
	case "anthropic":
		return c.AnthropicKey != ""
	default:
		return c.OpenAIKey != "" || c.AnthropicKey != ""
	}
}

// NewProvider creates a new AI provider based on configuration
func NewProvider(cfg *Config) (Provider, error) {
	switch cfg.Provider {
	case "openai":
		if cfg.OpenAIKey == "" {
			return nil, fmt.Errorf("OpenAI API key not configured. Set ai.openai.key or OPENAI_API_KEY")
		}
		return NewOpenAIProvider(cfg.OpenAIKey, cfg.OpenAIModel), nil
	case "anthropic":
		if cfg.AnthropicKey == "" {
			return nil, fmt.Errorf("Anthropic API key not configured. Set ai.anthropic.key or ANTHROPIC_API_KEY")
		}
		return NewAnthropicProvider(cfg.AnthropicKey, cfg.AnthropicModel), nil
	default:
		// Try to auto-detect
		if cfg.OpenAIKey != "" {
			return NewOpenAIProvider(cfg.OpenAIKey, cfg.OpenAIModel), nil
		}
		if cfg.AnthropicKey != "" {
			return NewAnthropicProvider(cfg.AnthropicKey, cfg.AnthropicModel), nil
		}
		return nil, fmt.Errorf("no AI provider configured. Set ai.provider to 'openai' or 'anthropic'")
	}
}

// IsDebug returns true if debug mode is enabled
func IsDebug() bool {
	return os.Getenv("CLERK_CLI_DEBUG") == "1" || os.Getenv("CLERK_CLI_DEBUG") == "true"
}

const systemPrompt = `You are an expert at writing Clerk Protect rule expressions. Your task is to convert natural language descriptions into valid rule expressions.

Rules about the expression syntax:
- Expressions must evaluate to a boolean (true/false)
- Use dot notation to access nested fields (e.g., ip.privacy.is_vpn)
- Comparison operators: ==, !=, <, >, <=, >=
- Logical operators: &&, ||, !
- String values must be quoted with double quotes
- Boolean fields can be used directly without comparison (e.g., ip.privacy.is_vpn, not ip.privacy.is_vpn == true)
- To negate a boolean field, use ! (e.g., !ip.privacy.is_vpn, not ip.privacy.is_vpn == false)
- Numbers can be integers or decimals

Common patterns:
- Block VPN: ip.privacy.is_vpn
- Block datacenter: ip.privacy.is_datacenter
- Block proxy: ip.privacy.is_proxy
- Allow only non-VPN: !ip.privacy.is_vpn
- Country check: ip.geo.country_code == "US"
- Bot score: botScore.risk > 0.7
- Phone country: phoneNumber.country_code == "US"

IMPORTANT:
- Return ONLY the expression, nothing else
- Do not include any explanation or markdown
- The expression must be valid and use only fields from the provided schema`
