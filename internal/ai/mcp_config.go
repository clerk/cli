package ai

import (
	"encoding/json"
	"os"
	"path/filepath"

	"clerk.com/cli/internal/config"
)

// MCPServerConfig defines the configuration for a single MCP server.
type MCPServerConfig struct {
	Command string            `json:"command"`
	Args    []string          `json:"args,omitempty"`
	Env     map[string]string `json:"env,omitempty"`
}

type mcpConfigFile struct {
	Servers map[string]MCPServerConfig `json:"servers"`
}

// LoadMCPServers loads MCP server configurations.
// It checks the flag value first, then the profile key "ai.mcp.config",
// then falls back to ~/.config/clerk/cli/mcp.json.
func LoadMCPServers(profileName, flagValue string) (map[string]MCPServerConfig, error) {
	// Check for profile-specific config path
	configPath := config.ResolveValue("ai.mcp.config", flagValue, "", "", profileName)

	if configPath == "" {
		// Default path
		configPath = filepath.Join(config.ConfigDir(), "mcp.json")
	}

	data, err := os.ReadFile(configPath) // #nosec G304 -- MCP config path is from known location
	if err != nil {
		if os.IsNotExist(err) {
			// No MCP config is fine — just means no tools available
			return nil, nil
		}
		return nil, err
	}

	var cfg mcpConfigFile
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, err
	}

	return cfg.Servers, nil
}
