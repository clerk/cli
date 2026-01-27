package cmd

import (
	"fmt"

	"clerk.com/cli/internal/config"
	"clerk.com/cli/internal/output"
	"github.com/AlecAivazis/survey/v2"
	"github.com/spf13/cobra"
)

var initCmd = &cobra.Command{
	Use:   "init",
	Short: "Interactive setup wizard",
	Long:  "Initialize the Clerk CLI with an interactive setup wizard.",
	RunE:  runInit,
}

func runInit(cmd *cobra.Command, args []string) error {
	if !output.IsInteractive() {
		return fmt.Errorf("init requires an interactive terminal")
	}

	fmt.Println(output.BoldCyan("Welcome to the Clerk CLI!"))
	fmt.Println()
	fmt.Println("This wizard will help you set up your configuration.")
	fmt.Println()

	var apiKey string
	prompt := &survey.Password{
		Message: "Enter your Clerk Secret Key (sk_test_... or sk_live_...):",
	}
	if err := survey.AskOne(prompt, &apiKey); err != nil {
		return err
	}

	if apiKey == "" {
		return fmt.Errorf("API key is required")
	}

	profileName := "default"

	var useCustomProfile bool
	confirmPrompt := &survey.Confirm{
		Message: "Would you like to save this to a named profile instead of 'default'?",
		Default: false,
	}
	if err := survey.AskOne(confirmPrompt, &useCustomProfile); err != nil {
		return err
	}

	if useCustomProfile {
		namePrompt := &survey.Input{
			Message: "Profile name:",
		}
		if err := survey.AskOne(namePrompt, &profileName); err != nil {
			return err
		}
		if profileName == "" {
			profileName = "default"
		}
	}

	if err := config.SetProfileValue(profileName, "clerk.key", apiKey); err != nil {
		return fmt.Errorf("failed to save configuration: %w", err)
	}

	if profileName != "default" {
		if err := config.SetActiveProfile(profileName); err != nil {
			return fmt.Errorf("failed to set active profile: %w", err)
		}
	}

	fmt.Println()
	output.Success(fmt.Sprintf("Configuration saved to profile '%s'", profileName))
	fmt.Println()
	fmt.Println("You can now use the Clerk CLI. Try running:")
	fmt.Println(output.Cyan("  clerk users list"))
	fmt.Println()

	return nil
}
