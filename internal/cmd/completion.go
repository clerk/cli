package cmd

import (
	"os"

	"github.com/spf13/cobra"
)

var completionCmd = &cobra.Command{
	Use:   "completion <shell>",
	Short: "Generate shell completion script",
	Long: `Generate shell completion script for the specified shell.

Examples:
  # Zsh (add to ~/.zshrc or install via Homebrew)
  clerk completion zsh > $(brew --prefix)/share/zsh/site-functions/_clerk

  # Bash
  clerk completion bash > /etc/bash_completion.d/clerk

  # Fish
  clerk completion fish > ~/.config/fish/completions/clerk.fish`,
	ValidArgs: []string{"bash", "zsh", "fish", "powershell"},
	Args:      RequireArg("shell"),
	RunE: func(cmd *cobra.Command, args []string) error {
		switch args[0] {
		case "bash":
			return rootCmd.GenBashCompletionV2(os.Stdout, true)
		case "zsh":
			return rootCmd.GenZshCompletion(os.Stdout)
		case "fish":
			return rootCmd.GenFishCompletion(os.Stdout, true)
		case "powershell":
			return rootCmd.GenPowerShellCompletionWithDesc(os.Stdout)
		default:
			return cmd.Help()
		}
	},
}

func init() {
	rootCmd.AddCommand(completionCmd)
}
