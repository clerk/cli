package cmd

import (
	"fmt"
	"os"
	"strings"

	"clerk.com/cli/internal/config"
	"clerk.com/cli/internal/output"
	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"
)

var configCmd = &cobra.Command{
	Use:   "config",
	Short: "Manage CLI configuration",
	Long:  "Manage CLI configuration settings, profiles, and aliases.",
}

var configSetCmd = &cobra.Command{
	Use:   "set <key> <value>",
	Short: "Set config value",
	Args:  RequireArgs("key", "value"),
	RunE: func(cmd *cobra.Command, args []string) error {
		key, value := args[0], args[1]
		valueType, _ := cmd.Flags().GetString("type")
		profileName := GetProfile()

		var err error
		if valueType == "command" {
			err = config.SetProfileValueWithType(profileName, key, value, valueType)
		} else {
			err = config.SetProfileValue(profileName, key, value)
		}

		if err != nil {
			return err
		}

		displayValue := value
		// Don't mask command-type values (the command itself isn't secret)
		if isSecretKey(key) && valueType != "command" {
			displayValue = maskAPIKey(value)
		}
		output.Success(fmt.Sprintf("Set %s = %s", key, displayValue))
		return nil
	},
}

var configGetCmd = &cobra.Command{
	Use:   "get <key>",
	Short: "Get config value",
	Args:  RequireArg("key"),
	RunE: func(cmd *cobra.Command, args []string) error {
		key := args[0]
		profileName := GetProfile()
		resolve, _ := cmd.Flags().GetBool("resolve")

		var value string
		var shouldMask bool
		if resolve {
			// Resolve value including command execution
			value = config.ResolveValue(key, "", "", "", profileName)
			// Only mask resolved values for secret keys
			shouldMask = isSecretKey(key)
		} else {
			// Get raw value without command execution
			value = config.GetRawValue(profileName, key)
			// Don't mask command-type values (the command itself isn't secret)
			shouldMask = isSecretKey(key) && !config.IsCommandType(profileName, key)
		}

		if value == "" {
			fmt.Println("(not set)")
		} else {
			if shouldMask {
				fmt.Println(maskAPIKey(value))
			} else {
				fmt.Println(value)
			}
		}
		return nil
	},
}

var configUnsetCmd = &cobra.Command{
	Use:   "unset <key>",
	Short: "Remove config value",
	Args:  RequireArg("key"),
	RunE: func(cmd *cobra.Command, args []string) error {
		key := args[0]
		profileName := GetProfile()

		if err := config.UnsetProfileValue(profileName, key); err != nil {
			return err
		}
		output.Success(fmt.Sprintf("Unset %s", key))
		return nil
	},
}

// Available config settings with their environment variables and defaults
var configSettings = []struct {
	Key     string
	EnvVar  string
	Default string
	Desc    string
}{
	{"clerk.key", "CLERK_SECRET_KEY", "", "Clerk secret API key"},
	{"clerk.api.url", "CLERK_API_URL", config.DefaultAPIURL, "Clerk API base URL"},
	{"output", "", config.DefaultOutputFormat, "Output format (table, json, yaml)"},
	{"debug", "CLERK_CLI_DEBUG", "false", "Enable debug logging"},
	{"ai.provider", "", "", "AI provider (openai, anthropic)"},
	{"ai.openai.key", "OPENAI_API_KEY", "", "OpenAI API key"},
	{"ai.openai.model", "", "gpt-4o", "OpenAI model"},
	{"ai.anthropic.key", "ANTHROPIC_API_KEY", "", "Anthropic API key"},
	{"ai.anthropic.model", "", "claude-sonnet-4-20250514", "Anthropic model"},
	{"ai.mcp.config", "", "", "Path to MCP servers config file"},
}

// isSecretKey returns true if the key contains sensitive data
func isSecretKey(key string) bool {
	return strings.HasSuffix(key, ".key") || strings.Contains(key, "secret") || strings.Contains(key, "token")
}

// truncateValue truncates a value to maxLen characters for display
// For masked values (containing *), it reduces the asterisks
// For plain values, it truncates and adds …
func truncateValue(value string, maxLen int) string {
	if len(value) <= maxLen {
		return value
	}

	// Check if this is a masked value (contains consecutive asterisks)
	asteriskStart := strings.Index(value, "**")
	if asteriskStart != -1 {
		// Find the end of the asterisk sequence
		asteriskEnd := asteriskStart
		for asteriskEnd < len(value) && value[asteriskEnd] == '*' {
			asteriskEnd++
		}

		prefix := value[:asteriskStart]
		suffix := value[asteriskEnd:]

		// Calculate how many asterisks we can keep
		// Format: prefix + *…* + suffix
		// We need at least 3 chars for *…* indicator
		available := maxLen - len(prefix) - len(suffix)
		if available >= 3 {
			return prefix + "*…*" + suffix
		}
		// If even that's too long, just truncate
		return value[:maxLen-1] + "…"
	}

	// Plain text: truncate and add ellipsis
	return value[:maxLen-1] + "…"
}

var configListCmd = &cobra.Command{
	Use:     "list",
	Aliases: []string{"ls"},
	Short:   "List all settings",
	RunE: func(cmd *cobra.Command, args []string) error {
		cfg, err := config.Load()
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		profileName := GetProfile()

		profile := cfg.Profiles[profileName]
		if profile == nil {
			profile = make(map[string]string)
		}

		// Build output data for all settings
		type settingInfo struct {
			Key    string `json:"key"`
			Value  string `json:"value"`
			Source string `json:"source"`
		}
		allSettings := make([]settingInfo, 0, len(configSettings))

		for _, s := range configSettings {
			info := settingInfo{Key: s.Key}

			// Check environment variable first
			if s.EnvVar != "" {
				if envVal := os.Getenv(s.EnvVar); envVal != "" {
					info.Value = envVal
					info.Source = "env:" + s.EnvVar
					if isSecretKey(s.Key) {
						info.Value = maskAPIKey(envVal)
					}
					allSettings = append(allSettings, info)
					continue
				}
			}

			// Check profile value
			if val, ok := profile[s.Key]; ok && val != "" {
				info.Value = val
				info.Source = "profile"
				// Don't mask command-type values (the command itself isn't secret)
				if isSecretKey(s.Key) && !config.IsCommandType(profileName, s.Key) {
					info.Value = maskAPIKey(val)
				}
				allSettings = append(allSettings, info)
				continue
			}

			// Use default
			if s.Default != "" {
				info.Value = s.Default
				info.Source = "default"
			} else {
				info.Value = output.Dim("(not set)")
				info.Source = ""
			}
			allSettings = append(allSettings, info)
		}

		// Add any custom settings not in the standard list
		for k, v := range profile {
			found := false
			for _, s := range configSettings {
				if s.Key == k {
					found = true
					break
				}
			}
			if !found {
				info := settingInfo{Key: k, Value: v, Source: "profile"}
				// Don't mask command-type values (the command itself isn't secret)
				if isSecretKey(k) && !config.IsCommandType(profileName, k) {
					info.Value = maskAPIKey(v)
				}
				allSettings = append(allSettings, info)
			}
		}

		return formatter.Output(allSettings, func() {
			fmt.Println(output.BoldYellow("Profile:"), output.Cyan(profileName))
			fmt.Println()

			rows := make([][]string, len(allSettings))
			for i, s := range allSettings {
				source := s.Source
				if source == "" {
					source = "-"
				}
				// Truncate long values for display
				displayValue := truncateValue(s.Value, 50)
				rows[i] = []string{s.Key, displayValue, source}
			}
			output.Table([]string{"KEY", "VALUE", "SOURCE"}, rows)
		})
	},
}

var configPathCmd = &cobra.Command{
	Use:   "path",
	Short: "Show config file path",
	Run: func(cmd *cobra.Command, args []string) {
		fmt.Println(config.ConfigFile())
	},
}

var profileCmd = &cobra.Command{
	Use:   "profile",
	Short: "Manage profiles",
}

var profileListCmd = &cobra.Command{
	Use:     "list",
	Aliases: []string{"ls"},
	Short:   "List profiles",
	RunE: func(cmd *cobra.Command, args []string) error {
		profiles := config.ListProfiles()
		activeProfile := config.GetActiveProfileName("")

		formatter := GetFormatter()

		data := make([]map[string]interface{}, len(profiles))
		for i, name := range profiles {
			data[i] = map[string]interface{}{
				"name":   name,
				"active": name == activeProfile,
			}
		}

		return formatter.Output(data, func() {
			rows := make([][]string, len(profiles))
			for i, name := range profiles {
				active := ""
				if name == activeProfile {
					active = "*"
				}
				rows[i] = []string{active, name}
			}
			output.Table([]string{"", "NAME"}, rows)
		})
	},
}

var profileCreateCmd = &cobra.Command{
	Use:   "create <name>",
	Short: "Create profile",
	Args:  RequireArg("profile-name"),
	RunE: func(cmd *cobra.Command, args []string) error {
		name := args[0]
		if err := config.CreateProfile(name); err != nil {
			return err
		}

		// Set optional values from flags
		if apiKey, _ := cmd.Flags().GetString("api-key"); apiKey != "" {
			if err := config.SetProfileValue(name, "clerk.key", apiKey); err != nil {
				return err
			}
		}
		if apiURL, _ := cmd.Flags().GetString("api-url"); apiURL != "" {
			if err := config.SetProfileValue(name, "clerk.api.url", apiURL); err != nil {
				return err
			}
		}

		output.Success(fmt.Sprintf("Created profile '%s'", name))
		return nil
	},
}

var profileUpdateCmd = &cobra.Command{
	Use:   "update <name>",
	Short: "Update profile",
	Args:  RequireArg("profile-name"),
	RunE: func(cmd *cobra.Command, args []string) error {
		output.Info("Use 'clerk config set <key> <value> --profile <name>' to update profile settings")
		return nil
	},
}

var profileDeleteCmd = &cobra.Command{
	Use:   "delete <name>",
	Short: "Delete profile",
	Args:  RequireArg("profile-name"),
	RunE: func(cmd *cobra.Command, args []string) error {
		name := args[0]

		force, _ := cmd.Flags().GetBool("force")
		if !force && output.IsInteractive() {
			var confirm bool
			err := huh.NewConfirm().
				Title(fmt.Sprintf("Delete profile '%s'?", name)).
				Value(&confirm).
				Run()
			if err != nil {
				return err
			}
			if !confirm {
				fmt.Println("Cancelled")
				return nil
			}
		}

		if err := config.DeleteProfile(name); err != nil {
			return err
		}
		output.Success(fmt.Sprintf("Deleted profile '%s'", name))
		return nil
	},
}

var profileUseCmd = &cobra.Command{
	Use:   "use <name>",
	Short: "Set active profile",
	Args:  RequireArg("profile-name"),
	RunE: func(cmd *cobra.Command, args []string) error {
		name := args[0]
		if err := config.SetActiveProfile(name); err != nil {
			return err
		}
		output.Success(fmt.Sprintf("Switched to profile '%s'", name))
		return nil
	},
}

var profileShowCmd = &cobra.Command{
	Use:   "show [name]",
	Short: "Show profile details",
	Args:  cobra.MaximumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		name := GetProfile()
		if len(args) > 0 {
			name = args[0]
		}

		profile := config.GetProfile(name)
		formatter := GetFormatter()

		data := map[string]interface{}{
			"name":        name,
			"clerk.key":   maskAPIKey(profile.APIKey),
			"clerk.api.url": profile.APIURL,
		}

		return formatter.Output(data, func() {
			fmt.Println(output.BoldYellow("Profile:"), output.Cyan(name))
			fmt.Println(output.Dim("clerk.key:"), maskAPIKey(profile.APIKey))
			apiURL := profile.APIURL
			if apiURL == "" {
				apiURL = config.DefaultAPIURL + " (default)"
			}
			fmt.Println(output.Dim("clerk.api.url:"), apiURL)
		})
	},
}

var profilePathCmd = &cobra.Command{
	Use:   "path",
	Short: "Show profiles file path",
	Run: func(cmd *cobra.Command, args []string) {
		fmt.Println(config.ConfigFile())
	},
}

var aliasCmd = &cobra.Command{
	Use:   "alias",
	Short: "Manage aliases",
}

var aliasAddCmd = &cobra.Command{
	Use:   "add <name> <command...>",
	Short: "Create alias",
	Args:  cobra.MinimumNArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		name := args[0]
		command := strings.Join(args[1:], " ")
		if err := config.AddAlias(name, command); err != nil {
			return err
		}
		output.Success(fmt.Sprintf("Created alias '%s' -> '%s'", name, command))
		return nil
	},
}

var aliasRemoveCmd = &cobra.Command{
	Use:     "remove <name>",
	Aliases: []string{"rm"},
	Short:   "Remove alias",
	Args:    RequireArg("alias-name"),
	RunE: func(cmd *cobra.Command, args []string) error {
		name := args[0]
		if err := config.RemoveAlias(name); err != nil {
			return err
		}
		output.Success(fmt.Sprintf("Removed alias '%s'", name))
		return nil
	},
}

var aliasListCmd = &cobra.Command{
	Use:     "list",
	Aliases: []string{"ls"},
	Short:   "List aliases",
	RunE: func(cmd *cobra.Command, args []string) error {
		aliases, err := config.LoadAliases()
		if err != nil {
			return err
		}

		formatter := GetFormatter()

		return formatter.Output(aliases, func() {
			if len(aliases) == 0 {
				fmt.Println("No aliases configured")
				return
			}

			rows := make([][]string, 0, len(aliases))
			for name, command := range aliases {
				rows = append(rows, []string{name, command})
			}
			output.Table([]string{"NAME", "COMMAND"}, rows)
		})
	},
}

var aliasPathCmd = &cobra.Command{
	Use:   "path",
	Short: "Show aliases file path",
	Run: func(cmd *cobra.Command, args []string) {
		fmt.Println(config.AliasesFile())
	},
}

func init() {
	configSetCmd.Flags().String("type", "", "Value type (command)")
	configGetCmd.Flags().Bool("resolve", false, "Resolve command-type values")

	profileCreateCmd.Flags().String("api-key", "", "API key for the profile")
	profileCreateCmd.Flags().String("api-url", "", "API URL for the profile")

	profileDeleteCmd.Flags().BoolP("force", "f", false, "Skip confirmation prompt")

	configCmd.AddCommand(configSetCmd)
	configCmd.AddCommand(configGetCmd)
	configCmd.AddCommand(configUnsetCmd)
	configCmd.AddCommand(configListCmd)
	configCmd.AddCommand(configPathCmd)
	configCmd.AddCommand(profileCmd)
	configCmd.AddCommand(aliasCmd)

	profileCmd.AddCommand(profileListCmd)
	profileCmd.AddCommand(profileCreateCmd)
	profileCmd.AddCommand(profileUpdateCmd)
	profileCmd.AddCommand(profileDeleteCmd)
	profileCmd.AddCommand(profileUseCmd)
	profileCmd.AddCommand(profileShowCmd)
	profileCmd.AddCommand(profilePathCmd)

	aliasCmd.AddCommand(aliasAddCmd)
	aliasCmd.AddCommand(aliasRemoveCmd)
	aliasCmd.AddCommand(aliasListCmd)
	aliasCmd.AddCommand(aliasPathCmd)
}
