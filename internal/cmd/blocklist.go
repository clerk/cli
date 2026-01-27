package cmd

import (
	"fmt"
	"time"

	"clerk.com/cli/internal/api"
	"clerk.com/cli/internal/output"
	"github.com/spf13/cobra"
)

var blocklistCmd = &cobra.Command{
	Use:   "blocklist",
	Short: "Manage blocklist",
	Long:  "Manage the blocklist of identifiers for your Clerk instance.",
}

var blocklistListCmd = &cobra.Command{
	Use:     "list",
	Aliases: []string{"ls"},
	Short:   "List blocklist",
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		blocklistAPI := api.NewBlocklistAPI(client)

		identifiers, err := blocklistAPI.List()
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(identifiers, func() {
			if len(identifiers) == 0 {
				fmt.Println("No blocklist identifiers found")
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

var blocklistAddCmd = &cobra.Command{
	Use:   "add <identifier>",
	Short: "Add to blocklist",
	Args:  RequireArg("identifier"),
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		blocklistAPI := api.NewBlocklistAPI(client)

		identifier, err := blocklistAPI.Add(api.AddBlocklistParams{
			Identifier: args[0],
		})
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(identifier, func() {
			output.Success(fmt.Sprintf("Added %s to blocklist", identifier.Identifier))
		})
	},
}

var blocklistRemoveCmd = &cobra.Command{
	Use:     "remove <blocklist-id>",
	Aliases: []string{"rm"},
	Short:   "Remove from blocklist",
	Args:    RequireArg("blocklist-id"),
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		blocklistAPI := api.NewBlocklistAPI(client)

		if err := blocklistAPI.Remove(args[0]); err != nil {
			return err
		}

		output.Success(fmt.Sprintf("Removed %s from blocklist", args[0]))
		return nil
	},
}

func init() {
	blocklistCmd.AddCommand(blocklistListCmd)
	blocklistCmd.AddCommand(blocklistAddCmd)
	blocklistCmd.AddCommand(blocklistRemoveCmd)
}
