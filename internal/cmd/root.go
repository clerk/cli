package cmd

import (
	"fmt"
	"os"
	"strings"

	"clerk.com/cli/internal/api"
	"clerk.com/cli/internal/config"
	"clerk.com/cli/internal/output"
	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

var (
	profileFlag string
	outputFlag  string
	debugFlag   bool

	Version = "dev"
)

var rootCmd = &cobra.Command{
	Use:   "clerk",
	Short: "Clerk CLI - Manage your Clerk authentication instance",
	Long: `Clerk CLI is a command-line interface for managing Clerk authentication instances.

It provides commands for managing users, organizations, sessions, API keys,
domains, JWT templates, and security rules (Clerk Protect).`,
	SilenceUsage:  true,
	SilenceErrors: true,
	PersistentPreRunE: func(cmd *cobra.Command, args []string) error {
		config.Load()
		return nil
	},
}

func Execute() error {
	args := os.Args[1:]

	// First expand aliases
	expandedArgs, wasExpanded := config.ExpandAlias(args)
	if wasExpanded {
		args = expandedArgs
	}

	// Then expand command prefixes (e.g., "prot rul list" -> "protect rules list")
	args = expandPrefixArgs(rootCmd, args)

	// Update os.Args with the fully expanded arguments
	os.Args = append([]string{os.Args[0]}, args...)

	if err := rootCmd.Execute(); err != nil {
		output.DisplayError(err)
		return err
	}
	return nil
}

func init() {
	rootCmd.PersistentFlags().StringVarP(&profileFlag, "profile", "p", "", "Use specific profile")
	rootCmd.PersistentFlags().StringVarP(&outputFlag, "output", "o", "table", "Output format: table, json, yaml")
	rootCmd.PersistentFlags().BoolVar(&debugFlag, "debug", false, "Enable debug mode")

	rootCmd.Version = Version
	rootCmd.SetVersionTemplate("clerk version {{.Version}}\n")

	api.Version = Version

	rootCmd.SetUsageFunc(colorizedUsage)
	rootCmd.SetHelpFunc(colorizedHelp)

	addCommands()
}

func addCommands() {
	rootCmd.AddCommand(initCmd)
	rootCmd.AddCommand(whoamiCmd)
	rootCmd.AddCommand(configCmd)
	rootCmd.AddCommand(usersCmd)
	rootCmd.AddCommand(organizationsCmd)
	rootCmd.AddCommand(sessionsCmd)
	rootCmd.AddCommand(apiKeysCmd)
	rootCmd.AddCommand(invitationsCmd)
	rootCmd.AddCommand(restrictionsCmd)
	rootCmd.AddCommand(domainsCmd)
	rootCmd.AddCommand(jwtTemplatesCmd)
	rootCmd.AddCommand(instanceCmd)
	rootCmd.AddCommand(jwksCmd)
	rootCmd.AddCommand(m2mCmd)
	rootCmd.AddCommand(protectCmd)
}

func GetProfile() string {
	return config.GetActiveProfileName(profileFlag)
}

func GetFormatter() *output.Formatter {
	format := config.ResolveValue("output", outputFlag, "", string(output.FormatTable), GetProfile())
	return output.NewFormatter(format)
}

func IsDebug() bool {
	return debugFlag || config.IsDebugEnabled()
}

// GetClient creates an API client, prompting for the API key only if no
// configuration exists at all and the terminal is interactive.
// If a non-default profile was explicitly requested but doesn't exist, it errors.
func GetClient() (*api.Client, error) {
	profileName := GetProfile()

	// If a non-default profile was explicitly specified, it must exist
	if profileName != "default" && !config.ProfileExists(profileName) {
		return nil, fmt.Errorf("profile '%s' does not exist\n\nCreate it with:\n  clerk config profile create %s", profileName, profileName)
	}

	apiKey := config.GetAPIKey(profileName)

	// Only prompt if there's no configuration at all (fresh install)
	if apiKey == "" && !config.HasAnyConfig() && output.IsInteractive() {
		var err error
		apiKey, err = promptForAPIKey(profileName)
		if err != nil {
			return nil, err
		}
	}

	if apiKey == "" {
		return nil, fmt.Errorf("API key not configured. Run 'clerk init' or set CLERK_SECRET_KEY environment variable")
	}

	return api.NewClient(api.ClientOptions{
		Profile: profileName,
		APIKey:  apiKey,
		Debug:   IsDebug(),
	}), nil
}

func promptForAPIKey(profileName string) (string, error) {
	output.Warn("No API key configured")
	fmt.Println()

	var apiKey string
	err := huh.NewInput().
		Title("Enter your Clerk secret key:").
		EchoMode(huh.EchoModePassword).
		Value(&apiKey).
		Run()
	if err != nil {
		return "", err
	}

	if apiKey == "" {
		return "", fmt.Errorf("API key is required")
	}

	// Ask if they want to save the key
	var saveKey bool
	err = huh.NewConfirm().
		Title(fmt.Sprintf("Save key to profile '%s'?", profileName)).
		Affirmative("Yes").
		Negative("No").
		Value(&saveKey).
		Run()
	if err != nil {
		return apiKey, nil // Return the key even if we can't ask about saving
	}

	if saveKey {
		if err := config.SetProfileValue(profileName, "clerk.key", apiKey); err != nil {
			output.Warn(fmt.Sprintf("Failed to save key: %v", err))
		} else {
			output.Success(fmt.Sprintf("Key saved to profile '%s'", profileName))
		}
	}

	return apiKey, nil
}

func colorizedUsage(cmd *cobra.Command) error {
	colorizedHelp(cmd, nil)
	return nil
}

func colorizedHelp(cmd *cobra.Command, _ []string) {
	// fatih/color automatically handles NO_COLOR and non-TTY
	fmt.Println(output.BoldYellow("Usage:"))
	fmt.Printf("  %s\n\n", cmd.UseLine())

	if cmd.Long != "" {
		fmt.Println(cmd.Long)
		fmt.Println()
	} else if cmd.Short != "" {
		fmt.Println(cmd.Short)
		fmt.Println()
	}

	if cmd.HasAvailableSubCommands() {
		fmt.Println(output.BoldYellow("Commands:"))
		for _, sub := range cmd.Commands() {
			if sub.Hidden {
				continue
			}
			// Calculate visible width (without color codes) for proper alignment
			visibleName := sub.Name()
			if len(sub.Aliases) > 0 {
				visibleName += "|" + strings.Join(sub.Aliases, "|")
			}
			// Build the colorized version
			coloredName := output.Cyan(sub.Name())
			if len(sub.Aliases) > 0 {
				coloredName += output.Dim("|") + output.Cyan(strings.Join(sub.Aliases, output.Dim("|")))
			}
			// Pad based on visible width (30 chars total for name column)
			padding := 30 - len(visibleName)
			if padding < 1 {
				padding = 1
			}
			fmt.Printf("  %s%s%s\n", coloredName, strings.Repeat(" ", padding), output.Dim(sub.Short))
		}
		fmt.Println()
	}

	if cmd.HasAvailableLocalFlags() || cmd.HasAvailablePersistentFlags() {
		fmt.Println(output.BoldYellow("Options:"))
		printFlags(cmd)
		fmt.Println()
	}

	if cmd.HasAvailableSubCommands() {
		fmt.Printf("Use %s for more information about a command.\n",
			output.Cyan(fmt.Sprintf("%s [command] --help", cmd.CommandPath())))
	}
}

func printFlags(cmd *cobra.Command) {
	flags := cmd.Flags()
	flags.VisitAll(func(f *pflag.Flag) {
		if f.Hidden {
			return
		}

		// Calculate visible width (without color codes)
		var visibleFlag string
		if f.Shorthand != "" {
			visibleFlag = "-" + f.Shorthand + ", --" + f.Name
		} else {
			visibleFlag = "    --" + f.Name
		}
		if f.Value.Type() != "bool" {
			visibleFlag += " <" + f.Value.Type() + ">"
		}

		// Build the colorized version
		var coloredFlag string
		if f.Shorthand != "" {
			coloredFlag = output.Green("-"+f.Shorthand) + ", " + output.Green("--"+f.Name)
		} else {
			coloredFlag = "    " + output.Green("--"+f.Name)
		}
		if f.Value.Type() != "bool" {
			coloredFlag += " " + output.Magenta("<"+f.Value.Type()+">")
		}

		desc := output.Dim(f.Usage)
		if f.DefValue != "" && f.DefValue != "false" {
			desc += output.Blue(" (default: " + f.DefValue + ")")
		}

		// Pad based on visible width (30 chars total for flag column, matching commands)
		padding := 30 - len(visibleFlag)
		if padding < 1 {
			padding = 1
		}
		fmt.Printf("  %s%s%s\n", coloredFlag, strings.Repeat(" ", padding), desc)
	})
}
