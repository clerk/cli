package cmd

import (
	"fmt"
	"time"

	"clerk.com/cli/internal/api"
	"clerk.com/cli/internal/output"
	"github.com/AlecAivazis/survey/v2"
	"github.com/spf13/cobra"
)

var apiKeysCmd = &cobra.Command{
	Use:   "api-keys",
	Short: "Manage API keys",
	Long:  "Manage API keys in your Clerk instance.",
}

var apiKeysListCmd = &cobra.Command{
	Use:     "list",
	Aliases: []string{"ls"},
	Short:   "List API keys",
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		apiKeysAPI := api.NewAPIKeysAPI(client)

		keys, err := apiKeysAPI.List()
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(keys, func() {
			if len(keys) == 0 {
				fmt.Println("No API keys found")
				return
			}

			rows := make([][]string, len(keys))
			for i, k := range keys {
				created := time.UnixMilli(k.CreatedAt).Format("2006-01-02")
				rows[i] = []string{k.ID, k.Name, k.Type, created}
			}
			output.Table([]string{"ID", "NAME", "TYPE", "CREATED"}, rows)
		})
	},
}

var apiKeysGetCmd = &cobra.Command{
	Use:   "get <api-key-id>",
	Short: "Get API key",
	Args:  RequireArg("api-key-id"),
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		apiKeysAPI := api.NewAPIKeysAPI(client)

		key, err := apiKeysAPI.Get(args[0])
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(key, func() {
			fmt.Println(output.BoldYellow("API Key:"), key.ID)
			fmt.Println(output.Dim("Name:"), key.Name)
			fmt.Println(output.Dim("Type:"), key.Type)
			fmt.Println(output.Dim("Created:"), time.UnixMilli(key.CreatedAt).Format(time.RFC3339))
		})
	},
}

var apiKeysCreateCmd = &cobra.Command{
	Use:   "create",
	Short: "Create API key",
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		apiKeysAPI := api.NewAPIKeysAPI(client)

		name, _ := cmd.Flags().GetString("name")
		keyType, _ := cmd.Flags().GetString("type")

		if name == "" {
			return fmt.Errorf("--name is required")
		}

		key, err := apiKeysAPI.Create(api.CreateAPIKeyParams{
			Name: name,
			Type: keyType,
		})
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(key, func() {
			output.Success(fmt.Sprintf("Created API key %s", key.ID))
			if key.Secret != "" {
				fmt.Println()
				fmt.Println(output.Yellow("Secret (save this, it won't be shown again):"))
				fmt.Println(key.Secret)
			}
		})
	},
}

var apiKeysRevokeCmd = &cobra.Command{
	Use:   "revoke <api-key-id>",
	Short: "Revoke API key",
	Args:  RequireArg("api-key-id"),
	RunE: func(cmd *cobra.Command, args []string) error {
		force, _ := cmd.Flags().GetBool("force")
		if !force && output.IsInteractive() {
			var confirm bool
			prompt := &survey.Confirm{
				Message: fmt.Sprintf("Revoke API key %s?", args[0]),
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

		client, err := GetClient()
		if err != nil {
			return err
		}
		apiKeysAPI := api.NewAPIKeysAPI(client)

		if err := apiKeysAPI.Revoke(args[0]); err != nil {
			return err
		}

		output.Success(fmt.Sprintf("Revoked API key %s", args[0]))
		return nil
	},
}

func init() {
	apiKeysCreateCmd.Flags().String("name", "", "API key name")
	apiKeysCreateCmd.Flags().String("type", "", "API key type")

	apiKeysRevokeCmd.Flags().BoolP("force", "f", false, "Skip confirmation prompt")

	apiKeysCmd.AddCommand(apiKeysListCmd)
	apiKeysCmd.AddCommand(apiKeysGetCmd)
	apiKeysCmd.AddCommand(apiKeysCreateCmd)
	apiKeysCmd.AddCommand(apiKeysRevokeCmd)
}
