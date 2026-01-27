package cmd

import (
	"fmt"
	"time"

	"clerk.com/cli/internal/api"
	"clerk.com/cli/internal/output"
	"github.com/spf13/cobra"
)

var allowlistCmd = &cobra.Command{
	Use:   "allowlist",
	Short: "Manage allowlist",
	Long:  "Manage the allowlist of identifiers for your Clerk instance.",
}

var allowlistListCmd = &cobra.Command{
	Use:     "list",
	Aliases: []string{"ls"},
	Short:   "List allowlist",
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		allowlistAPI := api.NewAllowlistAPI(client)

		identifiers, err := allowlistAPI.List()
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(identifiers, func() {
			if len(identifiers) == 0 {
				fmt.Println("No allowlist identifiers found")
				return
			}

			rows := make([][]string, len(identifiers))
			for i, id := range identifiers {
				created := time.UnixMilli(id.CreatedAt).Format("2006-01-02")
				rows[i] = []string{id.ID, id.Identifier, id.IdentifierType, created}
			}
			output.Table([]string{"ID", "IDENTIFIER", "TYPE", "CREATED"}, rows)
		})
	},
}

var allowlistAddCmd = &cobra.Command{
	Use:   "add <identifier>",
	Short: "Add to allowlist",
	Args:  RequireArg("identifier"),
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		allowlistAPI := api.NewAllowlistAPI(client)

		notify, _ := cmd.Flags().GetBool("notify")

		identifier, err := allowlistAPI.Add(api.AddAllowlistParams{
			Identifier: args[0],
			Notify:     notify,
		})
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(identifier, func() {
			output.Success(fmt.Sprintf("Added %s to allowlist", identifier.Identifier))
		})
	},
}

var allowlistRemoveCmd = &cobra.Command{
	Use:     "remove <allowlist-id>",
	Aliases: []string{"rm"},
	Short:   "Remove from allowlist",
	Args:    RequireArg("allowlist-id"),
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		allowlistAPI := api.NewAllowlistAPI(client)

		if err := allowlistAPI.Remove(args[0]); err != nil {
			return err
		}

		output.Success(fmt.Sprintf("Removed %s from allowlist", args[0]))
		return nil
	},
}

func init() {
	allowlistAddCmd.Flags().Bool("notify", false, "Send notification email")

	allowlistCmd.AddCommand(allowlistListCmd)
	allowlistCmd.AddCommand(allowlistAddCmd)
	allowlistCmd.AddCommand(allowlistRemoveCmd)
}
