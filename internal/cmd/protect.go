package cmd

import (
	"fmt"
	"os"
	"os/exec"
	"strings"

	"clerk.com/cli/internal/ai"
	"clerk.com/cli/internal/api"
	"clerk.com/cli/internal/config"
	"clerk.com/cli/internal/output"
	"github.com/AlecAivazis/survey/v2"
	"github.com/spf13/cobra"
	"gopkg.in/yaml.v3"
)

var protectCmd = &cobra.Command{
	Use:   "protect",
	Short: "Manage Clerk Protect",
	Long:  "Manage Clerk Protect rules and schema.",
}

// Rules subcommands
var protectRulesCmd = &cobra.Command{
	Use:   "rules",
	Short: "Manage protect rules",
}

var protectRulesListCmd = &cobra.Command{
	Use:     "list [ruleset]",
	Aliases: []string{"ls"},
	Short:   "List rules",
	Long:    "List rules for a specific ruleset, or all rulesets if none specified.",
	Args:    cobra.MaximumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		protectAPI := api.NewProtectAPI(client)
		formatter := GetFormatter()

		// If a specific ruleset is provided, list only that one
		if len(args) > 0 {
			ruleset := strings.ToUpper(args[0])
			rules, _, err := protectAPI.ListRules(ruleset)
			if err != nil {
				return err
			}

			return formatter.Output(rules, func() {
				if len(rules) == 0 {
					fmt.Println("No rules found for ruleset:", ruleset)
					return
				}

				rows := make([][]string, len(rules))
				for i, r := range rules {
					expr := r.Expression
					if len(expr) > 40 {
						expr = expr[:37] + "..."
					}
					rows[i] = []string{r.ID, fmt.Sprintf("%d", r.Position), r.Action, expr}
				}
				output.Table([]string{"ID", "POS", "ACTION", "EXPRESSION"}, rows)
			})
		}

		// No ruleset specified - iterate through all event types
		allRules := make(map[string][]api.Rule)
		var totalRules int

		for _, eventType := range api.EventTypes {
			rules, _, err := protectAPI.ListRules(eventType)
			if err != nil {
				// Skip event types that fail (may not be enabled)
				continue
			}
			if len(rules) > 0 {
				allRules[eventType] = rules
				totalRules += len(rules)
			}
		}

		return formatter.Output(allRules, func() {
			if totalRules == 0 {
				fmt.Println("No rules found in any ruleset")
				return
			}

			first := true
			for _, eventType := range api.EventTypes {
				rules, ok := allRules[eventType]
				if !ok || len(rules) == 0 {
					continue
				}

				if !first {
					fmt.Println()
				}
				first = false

				fmt.Println(output.BoldYellow(eventType))

				rows := make([][]string, len(rules))
				for i, r := range rules {
					expr := r.Expression
					if len(expr) > 40 {
						expr = expr[:37] + "..."
					}
					rows[i] = []string{r.ID, fmt.Sprintf("%d", r.Position), r.Action, expr}
				}
				output.Table([]string{"ID", "POS", "ACTION", "EXPRESSION"}, rows)
			}
		})
	},
}

var protectRulesGetCmd = &cobra.Command{
	Use:   "get <ruleset> <rule-id>",
	Short: "Get rule",
	Args:  RequireArgs("ruleset", "rule-id"),
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		protectAPI := api.NewProtectAPI(client)

		ruleset := strings.ToUpper(args[0])
		id := args[1]

		rule, err := protectAPI.GetRule(ruleset, id)
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(rule, func() {
			fmt.Println(output.BoldYellow("Rule:"), rule.ID)
			fmt.Println(output.Dim("Position:"), rule.Position)
			fmt.Println(output.Dim("Action:"), rule.Action)
			fmt.Println(output.Dim("Expression:"), rule.Expression)
			if rule.Description != "" {
				fmt.Println(output.Dim("Description:"), rule.Description)
			}
		})
	},
}

var protectRulesAddCmd = &cobra.Command{
	Use:   "add [ruleset]",
	Short: "Add rule",
	Args:  cobra.MaximumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		protectAPI := api.NewProtectAPI(client)

		ruleset := ""
		if len(args) > 0 {
			ruleset = strings.ToUpper(args[0])
		}

		expression, _ := cmd.Flags().GetString("expression")
		action, _ := cmd.Flags().GetString("action")
		description, _ := cmd.Flags().GetString("description")
		position, _ := cmd.Flags().GetInt("position")
		generate, _ := cmd.Flags().GetString("generate")

		interactive := output.IsInteractive()

		// Prompt for ruleset if not provided
		if ruleset == "" {
			if interactive {
				var err error
				ruleset, err = promptRuleset()
				if err != nil {
					return err
				}
			} else {
				ruleset = "ALL"
			}
		}

		// Check if AI is configured for interactive mode hints
		aiConfig := ai.GetConfig(GetProfile())
		aiConfigured := aiConfig.IsConfigured()

		// If no expression and no generate flag, prompt interactively
		if expression == "" && generate == "" && interactive {
			// Ask how they want to create the expression
			if aiConfigured {
				method, err := promptExpressionMethod()
				if err != nil {
					return err
				}
				if method == "generate" {
					// Prompt for description to generate from
					generate, err = promptGenerateDescription()
					if err != nil {
						return err
					}
				} else {
					// Prompt for manual expression
					expression, err = promptExpression()
					if err != nil {
						return err
					}
				}
			} else {
				// AI not configured, offer to configure or write manually
				fmt.Println()
				output.Info("AI is not configured. AI can generate rule expressions from natural language.")
				fmt.Println()

				var wantConfigure bool
				configPrompt := &survey.Confirm{
					Message: "Would you like to configure AI now?",
					Default: false,
				}
				if err := survey.AskOne(configPrompt, &wantConfigure); err != nil {
					return err
				}

				if wantConfigure {
					newAIConfig, err := promptForAIConfig(GetProfile())
					if err != nil {
						return err
					}
					// Now offer to use AI generation
					method, err := promptExpressionMethod()
					if err != nil {
						return err
					}
					if method == "generate" {
						desc, err := promptGenerateDescription()
						if err != nil {
							return err
						}
						// Generate directly using the new config (in case it wasn't saved)
						expression, err = generateRuleExpressionWithConfig(protectAPI, ruleset, desc, newAIConfig)
						if err != nil {
							return err
						}
						if description == "" {
							description = desc
						}
					} else {
						expression, err = promptExpression()
						if err != nil {
							return err
						}
					}
				} else {
					// Manual expression entry
					var err error
					expression, err = promptExpression()
					if err != nil {
						return err
					}
				}
			}
		}

		// Handle AI generation
		if generate != "" {
			generatedExpr, err := generateRuleExpression(protectAPI, ruleset, generate)
			if err != nil {
				return err
			}
			expression = generatedExpr
			if description == "" {
				description = generate
			}
		}

		if expression == "" {
			return fmt.Errorf("--expression or --generate is required")
		}

		// Prompt for action if not provided
		if action == "" {
			if interactive {
				var err error
				action, err = promptAction()
				if err != nil {
					return err
				}
			} else {
				action = "BLOCK"
			}
		}

		// Prompt for description if not provided
		if description == "" && interactive {
			var err error
			description, err = promptDescription()
			if err != nil {
				return err
			}
		}

		params := api.CreateRuleParams{
			Expression:  expression,
			Action:      action,
			Description: description,
		}
		if position >= 0 {
			params.Position = &position
		}

		rule, err := protectAPI.CreateRule(ruleset, params)
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(rule, func() {
			output.Success(fmt.Sprintf("Created rule %s", rule.ID))
		})
	},
}

// Interactive prompt helpers

func promptRuleset() (string, error) {
	prompt := &survey.Select{
		Message: "Select ruleset:",
		Options: api.EventTypes,
		Default: "ALL",
	}
	var result string
	if err := survey.AskOne(prompt, &result, survey.WithIcons(surveyIcons)); err != nil {
		return "", err
	}
	return result, nil
}

func promptExpressionMethod() (string, error) {
	prompt := &survey.Select{
		Message: "How do you want to create the expression?",
		Options: []string{
			"Generate from description (AI)",
			"Write manually",
		},
		Default: "Generate from description (AI)",
	}
	var result string
	if err := survey.AskOne(prompt, &result, survey.WithIcons(surveyIcons)); err != nil {
		return "", err
	}
	if strings.HasPrefix(result, "Generate") {
		return "generate", nil
	}
	return "manual", nil
}

func promptGenerateDescription() (string, error) {
	prompt := &survey.Input{
		Message: "Describe the rule in plain English:",
		Help:    "e.g., 'block VPN users', 'only allow US phone numbers'",
	}
	var result string
	if err := survey.AskOne(prompt, &result, survey.WithValidator(survey.Required), survey.WithIcons(surveyIcons)); err != nil {
		return "", err
	}
	return result, nil
}

func promptExpression() (string, error) {
	prompt := &survey.Input{
		Message: "Enter rule expression:",
		Help:    "e.g., 'ip.privacy.is_vpn == true'",
	}
	var result string
	if err := survey.AskOne(prompt, &result, survey.WithValidator(survey.Required), survey.WithIcons(surveyIcons)); err != nil {
		return "", err
	}
	return result, nil
}

func promptAction() (string, error) {
	prompt := &survey.Select{
		Message: "Select action when expression matches:",
		Options: []string{"BLOCK", "ALLOW", "CHALLENGE"},
		Default: "BLOCK",
		Description: func(value string, index int) string {
			switch value {
			case "BLOCK":
				return "Deny the request"
			case "ALLOW":
				return "Allow the request"
			case "CHALLENGE":
				return "Present a challenge (e.g., CAPTCHA)"
			}
			return ""
		},
	}
	var result string
	if err := survey.AskOne(prompt, &result, survey.WithIcons(surveyIcons)); err != nil {
		return "", err
	}
	return result, nil
}

func promptDescription() (string, error) {
	prompt := &survey.Input{
		Message: "Description (optional):",
	}
	var result string
	if err := survey.AskOne(prompt, &result, survey.WithIcons(surveyIcons)); err != nil {
		return "", err
	}
	return result, nil
}

// Custom survey icons for better visual appearance
var surveyIcons = func(icons *survey.IconSet) {
	icons.Question.Text = "?"
	icons.Question.Format = "cyan+b"
	icons.SelectFocus.Text = "▸"
	icons.SelectFocus.Format = "cyan+b"
}

// generateRuleExpression uses AI to generate a rule expression from a description
func generateRuleExpression(protectAPI *api.ProtectAPI, ruleset, description string) (string, error) {
	// Get AI configuration
	aiConfig := ai.GetConfig(GetProfile())
	if !aiConfig.IsConfigured() {
		if !output.IsInteractive() {
			return "", fmt.Errorf("AI not configured. Set ai.provider and API key, or use OPENAI_API_KEY/ANTHROPIC_API_KEY environment variable")
		}

		// Interactive: offer to configure AI
		fmt.Println()
		output.Info("AI is not configured. AI can generate rule expressions from natural language descriptions.")
		fmt.Println()
		fmt.Println(output.Dim("  Example: \"Block requests from VPNs and data centers\""))
		fmt.Println(output.Dim("  Example: \"Allow only US phone numbers\""))
		fmt.Println()

		var wantConfigure bool
		prompt := &survey.Confirm{
			Message: "Would you like to configure AI now?",
			Default: true,
		}
		if err := survey.AskOne(prompt, &wantConfigure); err != nil {
			return "", err
		}
		if !wantConfigure {
			return "", fmt.Errorf("AI configuration required for expression generation")
		}

		// Configure AI interactively
		var err error
		aiConfig, err = promptForAIConfig(GetProfile())
		if err != nil {
			return "", err
		}
	}

	return generateRuleExpressionWithConfig(protectAPI, ruleset, description, aiConfig)
}

// generateRuleExpressionWithConfig uses AI to generate a rule expression with an explicit config
func generateRuleExpressionWithConfig(protectAPI *api.ProtectAPI, ruleset, description string, aiConfig *ai.Config) (string, error) {
	// Create AI provider
	provider, err := ai.NewProvider(aiConfig)
	if err != nil {
		return "", err
	}

	// Fetch schema for the ruleset
	schema, err := protectAPI.GetSchema(ruleset)
	if err != nil {
		return "", fmt.Errorf("failed to fetch schema: %w", err)
	}

	// Format schema for AI
	schemaStr := formatSchemaForAI(schema)

	fmt.Println(output.Dim("Generating expression for:"), description)
	fmt.Println()

	// Generate expression
	expression, err := provider.GenerateExpression(schemaStr, description)
	if err != nil {
		return "", fmt.Errorf("failed to generate expression: %w", err)
	}

	fmt.Println(output.BoldYellow("Generated expression:"))
	fmt.Println("  " + output.Cyan(expression))
	fmt.Println()

	// Ask for confirmation in interactive mode
	if output.IsInteractive() {
		var confirm bool
		prompt := &survey.Confirm{
			Message: "Create rule with this expression?",
			Default: true,
		}
		if err := survey.AskOne(prompt, &confirm); err != nil {
			return "", err
		}
		if !confirm {
			return "", fmt.Errorf("cancelled")
		}
	}

	return expression, nil
}

// promptForAIConfig interactively configures AI settings
func promptForAIConfig(profileName string) (*ai.Config, error) {
	// Select provider
	var provider string
	providerPrompt := &survey.Select{
		Message: "Select AI provider:",
		Options: []string{"OpenAI (Recommended)", "Anthropic"},
		Default: "OpenAI (Recommended)",
	}
	if err := survey.AskOne(providerPrompt, &provider); err != nil {
		return nil, err
	}

	// Normalize provider selection
	if strings.HasPrefix(provider, "OpenAI") {
		provider = "openai"
	} else {
		provider = "anthropic"
	}

	// Get API key
	var apiKey string
	var keyPrompt *survey.Password
	var keyConfigKey, modelConfigKey, defaultModel string

	if provider == "openai" {
		keyPrompt = &survey.Password{
			Message: "Enter your OpenAI API key:",
			Help:    "Get your API key from https://platform.openai.com/api-keys",
		}
		keyConfigKey = "ai.openai.key"
		modelConfigKey = "ai.openai.model"
		defaultModel = "gpt-4o"
	} else {
		keyPrompt = &survey.Password{
			Message: "Enter your Anthropic API key:",
			Help:    "Get your API key from https://console.anthropic.com/settings/keys",
		}
		keyConfigKey = "ai.anthropic.key"
		modelConfigKey = "ai.anthropic.model"
		defaultModel = "claude-sonnet-4-20250514"
	}

	if err := survey.AskOne(keyPrompt, &apiKey); err != nil {
		return nil, err
	}

	if apiKey == "" {
		return nil, fmt.Errorf("API key is required")
	}

	// Ask about model (with default)
	var useCustomModel bool
	modelPrompt := &survey.Confirm{
		Message: fmt.Sprintf("Use default model (%s)?", defaultModel),
		Default: true,
	}
	if err := survey.AskOne(modelPrompt, &useCustomModel); err != nil {
		return nil, err
	}

	model := defaultModel
	if !useCustomModel {
		var customModel string
		customModelPrompt := &survey.Input{
			Message: "Enter model name:",
			Default: defaultModel,
		}
		if err := survey.AskOne(customModelPrompt, &customModel); err != nil {
			return nil, err
		}
		if customModel != "" {
			model = customModel
		}
	}

	// Ask to save configuration
	var saveConfig bool
	savePrompt := &survey.Confirm{
		Message: fmt.Sprintf("Save AI configuration to profile '%s'?", profileName),
		Default: true,
	}
	if err := survey.AskOne(savePrompt, &saveConfig); err != nil {
		return nil, err
	}

	if saveConfig {
		if err := config.SetProfileValue(profileName, "ai.provider", provider); err != nil {
			output.Warn(fmt.Sprintf("Failed to save provider: %v", err))
		}
		if err := config.SetProfileValue(profileName, keyConfigKey, apiKey); err != nil {
			output.Warn(fmt.Sprintf("Failed to save API key: %v", err))
		}
		if model != defaultModel {
			if err := config.SetProfileValue(profileName, modelConfigKey, model); err != nil {
				output.Warn(fmt.Sprintf("Failed to save model: %v", err))
			}
		}
		output.Success("AI configuration saved")
		fmt.Println()
	}

	// Build and return the config
	cfg := &ai.Config{
		Provider: provider,
	}
	if provider == "openai" {
		cfg.OpenAIKey = apiKey
		cfg.OpenAIModel = model
	} else {
		cfg.AnthropicKey = apiKey
		cfg.AnthropicModel = model
	}

	return cfg, nil
}

// formatSchemaForAI converts a schema to a string format suitable for AI prompts
func formatSchemaForAI(schema *api.Schema) string {
	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("Event Type: %s\n\n", schema.EventType))
	sb.WriteString("Available fields:\n")
	formatSchemaFieldsForAI(&sb, schema.Fields, "")
	return sb.String()
}

func formatSchemaFieldsForAI(sb *strings.Builder, fields map[string]api.SchemaField, prefix string) {
	for name, field := range fields {
		fullName := name
		if prefix != "" {
			fullName = prefix + "." + name
		}

		if field.Description != "" {
			sb.WriteString(fmt.Sprintf("  %s (%s) - %s\n", fullName, field.Type, field.Description))
		} else {
			sb.WriteString(fmt.Sprintf("  %s (%s)\n", fullName, field.Type))
		}

		if len(field.Fields) > 0 {
			formatSchemaFieldsForAI(sb, field.Fields, fullName)
		}
	}
}

var protectRulesEditCmd = &cobra.Command{
	Use:   "edit <ruleset> <rule-id>",
	Short: "Edit rule in editor",
	Long:  "Open the rule in your editor ($EDITOR) for modification.",
	Args:  RequireArgs("ruleset", "rule-id"),
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		protectAPI := api.NewProtectAPI(client)

		ruleset := strings.ToUpper(args[0])
		id := args[1]

		// Check for direct flag updates (non-interactive mode)
		expression, _ := cmd.Flags().GetString("expression")
		action, _ := cmd.Flags().GetString("action")
		description, _ := cmd.Flags().GetString("description")

		if expression != "" || action != "" || description != "" {
			// Direct update via flags
			rule, err := protectAPI.UpdateRule(ruleset, id, api.UpdateRuleParams{
				Expression:  expression,
				Action:      action,
				Description: description,
			})
			if err != nil {
				return err
			}

			formatter := GetFormatter()
			return formatter.Output(rule, func() {
				output.Success(fmt.Sprintf("Updated rule %s", rule.ID))
			})
		}

		// Interactive editor mode - fetch existing rule first
		existingRule, err := protectAPI.GetRule(ruleset, id)
		if err != nil {
			return fmt.Errorf("failed to fetch rule: %w", err)
		}

		// Open in editor
		updatedRule, err := editRuleInEditor(existingRule)
		if err != nil {
			return err
		}

		// Check if anything changed
		if updatedRule.Expression == existingRule.Expression &&
			updatedRule.Action == existingRule.Action &&
			updatedRule.Description == existingRule.Description {
			fmt.Println(output.Dim("No changes made"))
			return nil
		}

		// Update the rule
		rule, err := protectAPI.UpdateRule(ruleset, id, api.UpdateRuleParams{
			Expression:  updatedRule.Expression,
			Action:      updatedRule.Action,
			Description: updatedRule.Description,
		})
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(rule, func() {
			output.Success(fmt.Sprintf("Updated rule %s", rule.ID))
		})
	},
}

// editableRule is the structure used for editing in the editor
type editableRule struct {
	Expression  string `yaml:"expression"`
	Action      string `yaml:"action"`
	Description string `yaml:"description,omitempty"`
}

func editRuleInEditor(rule *api.Rule) (*editableRule, error) {
	// Create editable structure
	editable := &editableRule{
		Expression:  rule.Expression,
		Action:      rule.Action,
		Description: rule.Description,
	}

	// Create temp file with YAML content
	tmpFile, err := os.CreateTemp("", "clerk-rule-*.yaml")
	if err != nil {
		return nil, fmt.Errorf("failed to create temp file: %w", err)
	}
	tmpPath := tmpFile.Name()
	defer os.Remove(tmpPath)

	// Write header comments and rule content
	header := `# Edit the rule below and save to apply changes.
# Lines starting with # are ignored.
# Available actions: ALLOW, BLOCK, CHALLENGE
#
`
	content, err := yaml.Marshal(editable)
	if err != nil {
		tmpFile.Close()
		return nil, fmt.Errorf("failed to marshal rule: %w", err)
	}

	if _, err := tmpFile.WriteString(header + string(content)); err != nil {
		tmpFile.Close()
		return nil, fmt.Errorf("failed to write temp file: %w", err)
	}
	tmpFile.Close()

	// Get editor from environment
	editor := os.Getenv("EDITOR")
	if editor == "" {
		editor = os.Getenv("VISUAL")
	}
	if editor == "" {
		// Try common editors
		for _, e := range []string{"vim", "vi", "nano", "notepad"} {
			if _, err := exec.LookPath(e); err == nil {
				editor = e
				break
			}
		}
	}
	if editor == "" {
		return nil, fmt.Errorf("no editor found. Set $EDITOR environment variable")
	}

	// Open editor
	editorCmd := exec.Command(editor, tmpPath)
	editorCmd.Stdin = os.Stdin
	editorCmd.Stdout = os.Stdout
	editorCmd.Stderr = os.Stderr

	if err := editorCmd.Run(); err != nil {
		return nil, fmt.Errorf("editor failed: %w", err)
	}

	// Read modified content
	modifiedContent, err := os.ReadFile(tmpPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read modified file: %w", err)
	}

	// Parse YAML (ignoring comment lines)
	var updated editableRule
	if err := yaml.Unmarshal(modifiedContent, &updated); err != nil {
		return nil, fmt.Errorf("failed to parse modified rule: %w", err)
	}

	// Validate
	if updated.Expression == "" {
		return nil, fmt.Errorf("expression cannot be empty")
	}
	if updated.Action == "" {
		return nil, fmt.Errorf("action cannot be empty")
	}
	updated.Action = strings.ToUpper(updated.Action)
	if updated.Action != "ALLOW" && updated.Action != "BLOCK" && updated.Action != "CHALLENGE" {
		return nil, fmt.Errorf("invalid action: %s (must be ALLOW, BLOCK, or CHALLENGE)", updated.Action)
	}

	return &updated, nil
}

var protectRulesDeleteCmd = &cobra.Command{
	Use:   "delete [ruleset] [id]",
	Short: "Delete rule",
	Args:  cobra.MaximumNArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		protectAPI := api.NewProtectAPI(client)

		interactive := output.IsInteractive()
		var ruleset, id string

		if len(args) >= 1 {
			ruleset = strings.ToUpper(args[0])
		}
		if len(args) >= 2 {
			id = args[1]
		}

		// Prompt for ruleset if not provided
		if ruleset == "" {
			if interactive {
				var err error
				ruleset, err = promptRuleset()
				if err != nil {
					return err
				}
			} else {
				return fmt.Errorf("ruleset is required")
			}
		}

		// Prompt for rule selection if ID not provided
		if id == "" {
			if interactive {
				var err error
				id, err = promptRuleSelection(protectAPI, ruleset)
				if err != nil {
					return err
				}
			} else {
				return fmt.Errorf("rule ID is required")
			}
		}

		// Confirm deletion
		force, _ := cmd.Flags().GetBool("force")
		if !force && interactive {
			var confirm bool
			prompt := &survey.Confirm{
				Message: fmt.Sprintf("Delete rule %s from %s?", output.Cyan(id), output.Yellow(ruleset)),
				Default: false,
			}
			if err := survey.AskOne(prompt, &confirm, survey.WithIcons(surveyIcons)); err != nil {
				return err
			}
			if !confirm {
				fmt.Println(output.Dim("Cancelled"))
				return nil
			}
		}

		if err := protectAPI.DeleteRule(ruleset, id); err != nil {
			return err
		}

		output.Success(fmt.Sprintf("Deleted rule %s", id))
		return nil
	},
}

func promptRuleSelection(protectAPI *api.ProtectAPI, ruleset string) (string, error) {
	rules, _, err := protectAPI.ListRules(ruleset)
	if err != nil {
		return "", err
	}

	if len(rules) == 0 {
		return "", fmt.Errorf("no rules found in %s ruleset", ruleset)
	}

	options := make([]string, len(rules))
	for i, r := range rules {
		expr := r.Expression
		if len(expr) > 50 {
			expr = expr[:47] + "..."
		}
		options[i] = fmt.Sprintf("%s  %s  %s", r.ID, output.Dim(r.Action), expr)
	}

	prompt := &survey.Select{
		Message:  "Select rule to delete:",
		Options:  options,
		PageSize: 10,
	}
	var selected string
	if err := survey.AskOne(prompt, &selected, survey.WithIcons(surveyIcons)); err != nil {
		return "", err
	}

	// Extract ID from selection
	parts := strings.Fields(selected)
	if len(parts) > 0 {
		return parts[0], nil
	}
	return "", fmt.Errorf("invalid selection")
}

var protectRulesFlushCmd = &cobra.Command{
	Use:   "flush <ruleset>",
	Short: "Delete all rules",
	Args:  RequireArg("ruleset"),
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		protectAPI := api.NewProtectAPI(client)

		ruleset := strings.ToUpper(args[0])

		force, _ := cmd.Flags().GetBool("force")
		if !force && output.IsInteractive() {
			var confirm bool
			prompt := &survey.Confirm{
				Message: fmt.Sprintf("Delete all rules in %s ruleset?", ruleset),
				Default: false,
			}
			if err := survey.AskOne(prompt, &confirm); err != nil {
				return err
			}
			if !confirm {
				fmt.Println("Cancelled")
				return nil
			}
		}

		if err := protectAPI.FlushRules(ruleset); err != nil {
			return err
		}

		output.Success(fmt.Sprintf("Flushed all rules from %s", ruleset))
		return nil
	},
}

var protectRulesReorderCmd = &cobra.Command{
	Use:   "reorder [ruleset]",
	Short: "Reorder rules interactively",
	Args:  cobra.MaximumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		protectAPI := api.NewProtectAPI(client)

		interactive := output.IsInteractive()
		var ruleset string

		if len(args) > 0 {
			ruleset = strings.ToUpper(args[0])
		} else if interactive {
			var err error
			ruleset, err = promptRuleset()
			if err != nil {
				return err
			}
		} else {
			return fmt.Errorf("ruleset is required")
		}

		rules, etag, err := protectAPI.ListRules(ruleset)
		if err != nil {
			return err
		}

		if len(rules) == 0 {
			fmt.Println(output.Yellow("No rules to reorder in"), output.Cyan(ruleset))
			return nil
		}

		orderStr, _ := cmd.Flags().GetString("order")
		var ruleIDs []string

		if orderStr == "" && interactive {
			// Interactive reordering
			fmt.Println(output.BoldYellow("Current rule order:"))
			fmt.Println()
			for i, r := range rules {
				expr := r.Expression
				if len(expr) > 50 {
					expr = expr[:47] + "..."
				}
				fmt.Printf("  %s %s  %s  %s\n",
					output.Cyan(fmt.Sprintf("%d.", i+1)),
					output.Dim(r.ID),
					output.Yellow(r.Action),
					expr)
			}
			fmt.Println()

			// Let user specify new order
			ruleIDs, err = promptReorder(rules)
			if err != nil {
				return err
			}
		} else if orderStr != "" {
			ruleIDs = strings.Split(orderStr, ",")
			for i := range ruleIDs {
				ruleIDs[i] = strings.TrimSpace(ruleIDs[i])
			}
		} else {
			fmt.Println(output.BoldYellow("Current order:"))
			for i, r := range rules {
				fmt.Printf("  %d. %s - %s\n", i+1, r.ID, r.Expression)
			}
			return fmt.Errorf("--order is required (comma-separated rule IDs)")
		}

		if err := protectAPI.ReorderRules(ruleset, ruleIDs, etag); err != nil {
			return err
		}

		output.Success("Reordered rules")
		return nil
	},
}

func promptReorder(rules []api.Rule) ([]string, error) {
	// Create options showing rule details
	options := make([]string, len(rules))
	idMap := make(map[string]string)
	for i, r := range rules {
		expr := r.Expression
		if len(expr) > 40 {
			expr = expr[:37] + "..."
		}
		label := fmt.Sprintf("%s  %s  %s", r.ID[:12]+"...", r.Action, expr)
		options[i] = label
		idMap[label] = r.ID
	}

	fmt.Println(output.Dim("Select rules in the order you want them (first = highest priority):"))
	fmt.Println(output.Dim("Press Enter to select each rule in order."))
	fmt.Println()

	var orderedIDs []string
	remaining := make([]string, len(options))
	copy(remaining, options)

	for i := 0; i < len(rules); i++ {
		if len(remaining) == 1 {
			// Auto-select last remaining
			orderedIDs = append(orderedIDs, idMap[remaining[0]])
			break
		}

		prompt := &survey.Select{
			Message:  fmt.Sprintf("Position %d:", i+1),
			Options:  remaining,
			PageSize: 10,
		}
		var selected string
		if err := survey.AskOne(prompt, &selected, survey.WithIcons(surveyIcons)); err != nil {
			return nil, err
		}

		orderedIDs = append(orderedIDs, idMap[selected])

		// Remove selected from remaining
		newRemaining := make([]string, 0, len(remaining)-1)
		for _, opt := range remaining {
			if opt != selected {
				newRemaining = append(newRemaining, opt)
			}
		}
		remaining = newRemaining
	}

	return orderedIDs, nil
}

// Schema subcommands
var protectSchemaCmd = &cobra.Command{
	Use:   "schema",
	Short: "Manage protect schema",
}

var protectSchemaShowCmd = &cobra.Command{
	Use:   "show [eventType]",
	Short: "Show schema",
	Args:  cobra.MaximumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		protectAPI := api.NewProtectAPI(client)

		var eventType string
		if len(args) > 0 {
			eventType = strings.ToUpper(args[0])
		} else if output.IsInteractive() {
			var err error
			eventType, err = promptEventType()
			if err != nil {
				return err
			}
		} else {
			eventType = "ALL"
		}

		schema, err := protectAPI.GetSchema(eventType)
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(schema, func() {
			fmt.Println(output.BoldYellow("Schema for:"), output.Cyan(schema.EventType))
			fmt.Println()
			printSchemaFields(schema.Fields, "")
		})
	},
}

func promptEventType() (string, error) {
	prompt := &survey.Select{
		Message: "Select event type:",
		Options: api.EventTypes,
		Default: "ALL",
		Description: func(value string, index int) string {
			switch value {
			case "ALL":
				return "Schema fields available in all event types"
			case "SIGN_IN":
				return "Sign-in authentication attempts"
			case "SIGN_UP":
				return "New user registrations"
			case "SMS":
				return "SMS verification requests"
			case "EMAIL":
				return "Email verification requests"
			}
			return ""
		},
	}
	var result string
	if err := survey.AskOne(prompt, &result, survey.WithIcons(surveyIcons)); err != nil {
		return "", err
	}
	return result, nil
}

func printSchemaFields(fields map[string]api.SchemaField, indent string) {
	for name, field := range fields {
		typeStr := field.Type
		if field.Description != "" {
			fmt.Printf("%s%s (%s) - %s\n", indent, output.Cyan(name), output.Dim(typeStr), output.Dim(field.Description))
		} else {
			fmt.Printf("%s%s (%s)\n", indent, output.Cyan(name), output.Dim(typeStr))
		}
		if len(field.Fields) > 0 {
			printSchemaFields(field.Fields, indent+"  ")
		}
	}
}

var protectSchemaListCmd = &cobra.Command{
	Use:     "list",
	Aliases: []string{"ls"},
	Short:   "List event types",
	RunE: func(cmd *cobra.Command, args []string) error {
		formatter := GetFormatter()
		return formatter.Output(api.EventTypes, func() {
			fmt.Println(output.BoldYellow("Available Event Types:"))
			for _, et := range api.EventTypes {
				fmt.Println("  -", et)
			}
		})
	},
}

var protectSchemaTypeCmd = &cobra.Command{
	Use:   "type [eventType]",
	Short: "Show field paths for expressions",
	Long:  "Show all available field paths that can be used in rule expressions.",
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		protectAPI := api.NewProtectAPI(client)

		var eventType string
		if len(args) > 0 {
			eventType = strings.ToUpper(args[0])
		} else if output.IsInteractive() {
			var err error
			eventType, err = promptEventType()
			if err != nil {
				return err
			}
		} else {
			eventType = "ALL"
		}

		schema, err := protectAPI.GetSchema(eventType)
		if err != nil {
			return err
		}

		flat, _ := cmd.Flags().GetBool("flat")

		formatter := GetFormatter()
		return formatter.Output(schema, func() {
			fmt.Println(output.BoldYellow("Schema:"), output.Cyan(schema.EventType))
			fmt.Println()

			if flat {
				// Flat output: show all paths in dot notation
				printFlatSchema(schema.Fields, "")
			} else {
				// Tree output: show hierarchical structure
				printTreeSchema(schema.Fields, "", true)
			}

			fmt.Println()
			fmt.Println(output.Dim("Use these field paths in rule expressions, e.g.:"))
			fmt.Println(output.Dim("  ") + output.Cyan("ip.privacy.is_vpn == true"))
			fmt.Println(output.Dim("  ") + output.Cyan("botScore.risk > 0.7"))
		})
	},
}

func printFlatSchema(fields map[string]api.SchemaField, prefix string) {
	// Sort field names for consistent output
	names := make([]string, 0, len(fields))
	for name := range fields {
		names = append(names, name)
	}
	sortStrings(names)

	for _, name := range names {
		field := fields[name]
		path := name
		if prefix != "" {
			path = prefix + "." + name
		}

		if field.Type == "struct" && len(field.Fields) > 0 {
			printFlatSchema(field.Fields, path)
		} else {
			typeColor := getTypeColor(field.Type)
			fmt.Printf("  %s %s\n", output.Cyan(path), typeColor)
		}
	}
}

func printTreeSchema(fields map[string]api.SchemaField, indent string, isLast bool) {
	// Sort field names for consistent output
	names := make([]string, 0, len(fields))
	for name := range fields {
		names = append(names, name)
	}
	sortStrings(names)

	for i, name := range names {
		field := fields[name]
		isLastField := i == len(names)-1

		// Determine the tree branch character
		branch := "├── "
		if isLastField {
			branch = "└── "
		}

		if field.Type == "struct" && len(field.Fields) > 0 {
			// Struct with children
			fmt.Printf("%s%s%s\n", indent, branch, output.Yellow(name))

			// Calculate new indent
			newIndent := indent
			if isLastField {
				newIndent += "    "
			} else {
				newIndent += "│   "
			}
			printTreeSchema(field.Fields, newIndent, isLastField)
		} else {
			// Leaf field
			typeColor := getTypeColor(field.Type)
			fmt.Printf("%s%s%s %s\n", indent, branch, output.Cyan(name), typeColor)
		}
	}
}

func getTypeColor(fieldType string) string {
	switch fieldType {
	case "STRING":
		return output.Green("string")
	case "INTEGER":
		return output.Magenta("int")
	case "FLOAT":
		return output.Magenta("float")
	case "BOOLEAN":
		return output.Blue("bool")
	default:
		return output.Dim(fieldType)
	}
}

func sortStrings(s []string) {
	for i := 0; i < len(s)-1; i++ {
		for j := i + 1; j < len(s); j++ {
			if s[i] > s[j] {
				s[i], s[j] = s[j], s[i]
			}
		}
	}
}

func init() {
	protectRulesAddCmd.Flags().String("expression", "", "Rule expression")
	protectRulesAddCmd.Flags().StringP("generate", "g", "", "Generate expression from natural language using AI")
	protectRulesAddCmd.Flags().String("action", "", "Rule action (ALLOW, BLOCK, CHALLENGE)")
	protectRulesAddCmd.Flags().String("description", "", "Rule description")
	protectRulesAddCmd.Flags().Int("position", -1, "Rule position")

	protectRulesEditCmd.Flags().String("expression", "", "New expression")
	protectRulesEditCmd.Flags().String("action", "", "New action")
	protectRulesEditCmd.Flags().String("description", "", "New description")

	protectRulesDeleteCmd.Flags().BoolP("force", "f", false, "Skip confirmation prompt")

	protectRulesFlushCmd.Flags().Bool("force", false, "Skip confirmation")

	protectRulesReorderCmd.Flags().String("order", "", "Comma-separated rule IDs in new order")

	protectRulesCmd.AddCommand(protectRulesListCmd)
	protectRulesCmd.AddCommand(protectRulesGetCmd)
	protectRulesCmd.AddCommand(protectRulesAddCmd)
	protectRulesCmd.AddCommand(protectRulesEditCmd)
	protectRulesCmd.AddCommand(protectRulesDeleteCmd)
	protectRulesCmd.AddCommand(protectRulesFlushCmd)
	protectRulesCmd.AddCommand(protectRulesReorderCmd)

	protectSchemaTypeCmd.Flags().Bool("flat", false, "Show flat list of field paths")

	protectSchemaCmd.AddCommand(protectSchemaShowCmd)
	protectSchemaCmd.AddCommand(protectSchemaListCmd)
	protectSchemaCmd.AddCommand(protectSchemaTypeCmd)

	protectCmd.AddCommand(protectRulesCmd)
	protectCmd.AddCommand(protectSchemaCmd)
}
