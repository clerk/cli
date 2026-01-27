package cmd

import (
	"fmt"
	"strings"

	"clerk.com/cli/internal/config"
	"clerk.com/cli/internal/output"
	"github.com/spf13/cobra"
)

var whoamiCmd = &cobra.Command{
	Use:   "whoami",
	Short: "Show active profile",
	Long:  "Display information about the currently active profile.",
	RunE:  runWhoami,
}

func runWhoami(cmd *cobra.Command, args []string) error {
	profileName := GetProfile()
	profile := config.GetProfile(profileName)

	formatter := GetFormatter()

	data := map[string]interface{}{
		"profile": profileName,
		"apiKey":  maskAPIKey(profile.APIKey),
		"apiUrl":  profile.APIURL,
	}

	if profile.APIURL == "" {
		data["apiUrl"] = config.DefaultAPIURL
	}

	return formatter.Output(data, func() {
		fmt.Println(output.BoldYellow("Active Profile:"), output.Cyan(profileName))
		fmt.Println()

		apiKey := profile.APIKey
		if apiKey == "" {
			fmt.Println(output.Yellow("⚠"), "No API key configured")
			fmt.Println()
			fmt.Println("Run", output.Cyan("clerk init"), "to set up your API key")
		} else {
			fmt.Println(output.Dim("API Key:"), maskAPIKey(apiKey))

			apiURL := profile.APIURL
			if apiURL == "" {
				apiURL = config.DefaultAPIURL
			}
			fmt.Println(output.Dim("API URL:"), apiURL)
		}
	})
}

func maskAPIKey(key string) string {
	if key == "" {
		return "(not set)"
	}

	if len(key) <= 12 {
		return strings.Repeat("*", len(key))
	}

	prefix := key[:8]
	suffix := key[len(key)-4:]
	masked := prefix + strings.Repeat("*", len(key)-12) + suffix
	return masked
}
