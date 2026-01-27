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
	"github.com/charmbracelet/huh"
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
				err := huh.NewConfirm().
					Title("Would you like to configure AI now?").
					Value(&wantConfigure).
					Run()
				if err != nil {
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
	options := make([]huh.Option[string], len(api.EventTypes))
	for i, et := range api.EventTypes {
		options[i] = huh.NewOption(et, et)
	}
	var result string
	err := huh.NewSelect[string]().
		Title("Select ruleset:").
		Options(options...).
		Value(&result).
		Run()
	if err != nil {
		return "", err
	}
	return result, nil
}

func promptExpressionMethod() (string, error) {
	var result string
	err := huh.NewSelect[string]().
		Title("How do you want to create the expression?").
		Options(
			huh.NewOption("Generate from description (AI)", "generate"),
			huh.NewOption("Write manually", "manual"),
		).
		Value(&result).
		Run()
	if err != nil {
		return "", err
	}
	return result, nil
}

func promptGenerateDescription() (string, error) {
	var result string
	err := huh.NewInput().
		Title("Describe the rule in plain English:").
		Description("e.g., 'block VPN users', 'only allow US phone numbers'").
		Value(&result).
		Validate(func(s string) error {
			if s == "" {
				return fmt.Errorf("description is required")
			}
			return nil
		}).
		Run()
	if err != nil {
		return "", err
	}
	return result, nil
}

func promptExpression() (string, error) {
	var result string
	err := huh.NewInput().
		Title("Enter rule expression:").
		Description("e.g., 'ip.privacy.is_vpn == true'").
		Value(&result).
		Validate(func(s string) error {
			if s == "" {
				return fmt.Errorf("expression is required")
			}
			return nil
		}).
		Run()
	if err != nil {
		return "", err
	}
	return result, nil
}

func promptAction() (string, error) {
	var result string
	err := huh.NewSelect[string]().
		Title("Select action when expression matches:").
		Options(
			huh.NewOption("BLOCK - Deny the request", "BLOCK"),
			huh.NewOption("ALLOW - Allow the request", "ALLOW"),
			huh.NewOption("CHALLENGE - Present a challenge (e.g., CAPTCHA)", "CHALLENGE"),
		).
		Value(&result).
		Run()
	if err != nil {
		return "", err
	}
	return result, nil
}

func promptDescription() (string, error) {
	var result string
	err := huh.NewInput().
		Title("Description (optional):").
		Value(&result).
		Run()
	if err != nil {
		return "", err
	}
	return result, nil
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

		wantConfigure := true
		err := huh.NewConfirm().
			Title("Would you like to configure AI now?").
			Value(&wantConfigure).
			Run()
		if err != nil {
			return "", err
		}
		if !wantConfigure {
			return "", fmt.Errorf("AI configuration required for expression generation")
		}

		// Configure AI interactively
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
		confirm := true
		err := huh.NewConfirm().
			Title("Create rule with this expression?").
			Value(&confirm).
			Run()
		if err != nil {
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
	err := huh.NewSelect[string]().
		Title("Select AI provider:").
		Options(
			huh.NewOption("OpenAI (Recommended)", "openai"),
			huh.NewOption("Anthropic", "anthropic"),
		).
		Value(&provider).
		Run()
	if err != nil {
		return nil, err
	}

	// Get API key
	var apiKey string
	var keyMessage, keyDescription string
	var keyConfigKey, modelConfigKey, defaultModel string

	if provider == "openai" {
		keyMessage = "Enter your OpenAI API key:"
		keyDescription = "Get your API key from https://platform.openai.com/api-keys"
		keyConfigKey = "ai.openai.key"
		modelConfigKey = "ai.openai.model"
		defaultModel = "gpt-4o"
	} else {
		keyMessage = "Enter your Anthropic API key:"
		keyDescription = "Get your API key from https://console.anthropic.com/settings/keys"
		keyConfigKey = "ai.anthropic.key"
		modelConfigKey = "ai.anthropic.model"
		defaultModel = "claude-sonnet-4-20250514"
	}

	err = huh.NewInput().
		Title(keyMessage).
		Description(keyDescription).
		EchoMode(huh.EchoModePassword).
		Value(&apiKey).
		Run()
	if err != nil {
		return nil, err
	}

	if apiKey == "" {
		return nil, fmt.Errorf("API key is required")
	}

	// Ask about model (with default)
	useDefaultModel := true
	err = huh.NewConfirm().
		Title(fmt.Sprintf("Use default model (%s)?", defaultModel)).
		Value(&useDefaultModel).
		Run()
	if err != nil {
		return nil, err
	}

	model := defaultModel
	if !useDefaultModel {
		customModel := defaultModel
		err = huh.NewInput().
			Title("Enter model name:").
			Value(&customModel).
			Run()
		if err != nil {
			return nil, err
		}
		if customModel != "" {
			model = customModel
		}
	}

	// Ask to save configuration
	saveConfig := true
	err = huh.NewConfirm().
		Title(fmt.Sprintf("Save AI configuration to profile '%s'?", profileName)).
		Value(&saveConfig).
		Run()
	if err != nil {
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
	Short: "Edit rule",
	Long:  "Edit a rule via flags, AI prompt, or $EDITOR.",
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
		aiPrompt, _ := cmd.Flags().GetString("ai")

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

		// AI-assisted edit
		if aiPrompt != "" {
			return editRuleWithAI(protectAPI, ruleset, id, aiPrompt)
		}

		// Interactive: prompt for method if AI is available
		if output.IsInteractive() {
			aiConfig := ai.GetConfig(GetProfile())
			if aiConfig.IsConfigured() {
				var method string
				err := huh.NewSelect[string]().
					Title("How do you want to edit the expression?").
					Options(
						huh.NewOption("Describe changes (AI)", "ai"),
						huh.NewOption("Open in editor", "editor"),
					).
					Value(&method).
					Run()
				if err != nil {
					return err
				}

				if method == "ai" {
					var modification string
					existingRule, err := protectAPI.GetRule(ruleset, id)
					if err != nil {
						return err
					}
					fmt.Println(output.Dim("Current expression:"), output.Cyan(existingRule.Expression))
					fmt.Println()

					err = huh.NewInput().
						Title("Describe how to modify the rule:").
						Value(&modification).
						Validate(func(s string) error {
							if s == "" {
								return fmt.Errorf("description is required")
							}
							return nil
						}).
						Run()
					if err != nil {
						return err
					}

					return editRuleWithAI(protectAPI, ruleset, id, modification)
				}
			}
		}

		// Editor mode - fetch existing rule first
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

func editRuleWithAI(protectAPI *api.ProtectAPI, ruleset, id, modification string) error {
	existingRule, err := protectAPI.GetRule(ruleset, id)
	if err != nil {
		return err
	}

	aiConfig := ai.GetConfig(GetProfile())
	if !aiConfig.IsConfigured() {
		return fmt.Errorf("AI not configured. Set ai.provider and API key, or use OPENAI_API_KEY/ANTHROPIC_API_KEY")
	}

	provider, err := ai.NewProvider(aiConfig)
	if err != nil {
		return err
	}

	schema, err := protectAPI.GetSchema(ruleset)
	if err != nil {
		return fmt.Errorf("failed to fetch schema: %w", err)
	}
	schemaStr := formatSchemaForAI(schema)

	fmt.Println(output.Dim("Current expression:"), output.Cyan(existingRule.Expression))
	fmt.Println(output.Dim("Modifying:"), modification)
	fmt.Println()

	newExpression, err := provider.ModifyExpression(schemaStr, existingRule.Expression, modification)
	if err != nil {
		return fmt.Errorf("failed to generate expression: %w", err)
	}

	fmt.Println(output.BoldYellow("Updated expression:"))
	fmt.Println("  " + output.Cyan(newExpression))
	fmt.Println()

	if output.IsInteractive() {
		confirm := true
		err := huh.NewConfirm().
			Title("Apply this change?").
			Value(&confirm).
			Run()
		if err != nil {
			return err
		}
		if !confirm {
			return fmt.Errorf("cancelled")
		}
	}

	rule, err := protectAPI.UpdateRule(ruleset, id, api.UpdateRuleParams{
		Expression: newExpression,
	})
	if err != nil {
		return err
	}

	formatter := GetFormatter()
	return formatter.Output(rule, func() {
		output.Success(fmt.Sprintf("Updated rule %s", rule.ID))
	})
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
			err := huh.NewConfirm().
				Title(fmt.Sprintf("Delete rule %s from %s?", id, ruleset)).
				Value(&confirm).
				Run()
			if err != nil {
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

	options := make([]huh.Option[string], len(rules))
	for i, r := range rules {
		expr := r.Expression
		if len(expr) > 50 {
			expr = expr[:47] + "..."
		}
		label := fmt.Sprintf("%s  %s  %s", r.ID, r.Action, expr)
		options[i] = huh.NewOption(label, r.ID)
	}

	var selected string
	err = huh.NewSelect[string]().
		Title("Select rule to delete:").
		Options(options...).
		Value(&selected).
		Run()
	if err != nil {
		return "", err
	}
	return selected, nil
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
			err := huh.NewConfirm().
				Title(fmt.Sprintf("Delete all rules in %s ruleset?", ruleset)).
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
	type ruleOption struct {
		label string
		id    string
	}

	allOptions := make([]ruleOption, len(rules))
	for i, r := range rules {
		expr := r.Expression
		if len(expr) > 40 {
			expr = expr[:37] + "..."
		}
		allOptions[i] = ruleOption{
			label: fmt.Sprintf("%s  %s  %s", r.ID[:12]+"...", r.Action, expr),
			id:    r.ID,
		}
	}

	fmt.Println(output.Dim("Select rules in the order you want them (first = highest priority):"))
	fmt.Println(output.Dim("Press Enter to select each rule in order."))
	fmt.Println()

	var orderedIDs []string
	remaining := make([]ruleOption, len(allOptions))
	copy(remaining, allOptions)

	for i := 0; i < len(rules); i++ {
		if len(remaining) == 1 {
			orderedIDs = append(orderedIDs, remaining[0].id)
			break
		}

		options := make([]huh.Option[string], len(remaining))
		for j, ro := range remaining {
			options[j] = huh.NewOption(ro.label, ro.id)
		}

		var selected string
		err := huh.NewSelect[string]().
			Title(fmt.Sprintf("Position %d:", i+1)).
			Options(options...).
			Value(&selected).
			Run()
		if err != nil {
			return nil, err
		}

		orderedIDs = append(orderedIDs, selected)

		// Remove selected from remaining
		newRemaining := make([]ruleOption, 0, len(remaining)-1)
		for _, ro := range remaining {
			if ro.id != selected {
				newRemaining = append(newRemaining, ro)
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
	eventTypeDescriptions := map[string]string{
		"ALL":     "Schema fields available in all event types",
		"SIGN_IN": "Sign-in authentication attempts",
		"SIGN_UP": "New user registrations",
		"SMS":     "SMS verification requests",
		"EMAIL":   "Email verification requests",
	}

	options := make([]huh.Option[string], len(api.EventTypes))
	for i, et := range api.EventTypes {
		label := et
		if desc, ok := eventTypeDescriptions[et]; ok {
			label = fmt.Sprintf("%s - %s", et, desc)
		}
		options[i] = huh.NewOption(label, et)
	}

	var result string
	err := huh.NewSelect[string]().
		Title("Select event type:").
		Options(options...).
		Value(&result).
		Run()
	if err != nil {
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

var protectStatusCmd = &cobra.Command{
	Use:   "status",
	Short: "Show or update Clerk Protect status",
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		protectAPI := api.NewProtectAPI(client)

		enableRules, _ := cmd.Flags().GetBool("enable-rules")
		disableRules, _ := cmd.Flags().GetBool("disable-rules")

		if enableRules && disableRules {
			return fmt.Errorf("cannot use --enable-rules and --disable-rules together")
		}

		var status *api.ProtectStatus
		if enableRules {
			status, err = protectAPI.SetRulesEnabled(true)
		} else if disableRules {
			status, err = protectAPI.SetRulesEnabled(false)
		} else {
			status, err = protectAPI.GetStatus()
		}
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(status, func() {
			fmt.Println(output.BoldYellow("Clerk Protect"))
			fmt.Println(output.Dim("Rules:  "), formatEnabled(status.RulesEnabled))
			fmt.Println(output.Dim("Specter:"), formatEnabled(status.SpecterEnabled))
		})
	},
}

func formatEnabled(v bool) string {
	if v {
		return output.Green("enabled")
	}
	return output.Red("disabled")
}

func init() {
	protectStatusCmd.Flags().Bool("enable-rules", false, "Enable protect rules")
	protectStatusCmd.Flags().Bool("disable-rules", false, "Disable protect rules")

	protectRulesAddCmd.Flags().String("expression", "", "Rule expression")
	protectRulesAddCmd.Flags().StringP("generate", "g", "", "Generate expression from natural language using AI")
	protectRulesAddCmd.Flags().String("action", "", "Rule action (ALLOW, BLOCK, CHALLENGE)")
	protectRulesAddCmd.Flags().String("description", "", "Rule description")
	protectRulesAddCmd.Flags().Int("position", -1, "Rule position")

	protectRulesEditCmd.Flags().String("expression", "", "New expression")
	protectRulesEditCmd.Flags().String("action", "", "New action")
	protectRulesEditCmd.Flags().String("description", "", "New description")
	protectRulesEditCmd.Flags().String("ai", "", "Describe changes in plain English (uses AI)")

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

	protectCmd.AddCommand(protectStatusCmd)
	protectCmd.AddCommand(protectRulesCmd)
	protectCmd.AddCommand(protectSchemaCmd)
}
