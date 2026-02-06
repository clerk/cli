package cmd

import (
	"fmt"
	"time"

	clerk "github.com/clerk/clerk-sdk-go/v2"
	sdkallowlist "github.com/clerk/clerk-sdk-go/v2/allowlistidentifier"
	sdkblocklist "github.com/clerk/clerk-sdk-go/v2/blocklistidentifier"
	"github.com/spf13/cobra"

	"clerk.com/cli/internal/api"
	"clerk.com/cli/internal/output"
)

var restrictionsCmd = &cobra.Command{
	Use:   "restrictions",
	Short: "Allowlist and blocklist restrictions",
	Long:  "Manage allowlist and blocklist restrictions for your Clerk instance.",
}

var restrictionsListCmd = &cobra.Command{
	Use:     "list",
	Aliases: []string{"ls"},
	Short:   "List all restrictions",
	Long:    "List all allowlist and blocklist identifiers.",
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		restrictionsAPI := api.NewRestrictionsAPI(client)

		allowlist, err := restrictionsAPI.ListAllowlist()
		if err != nil {
			return err
		}

		blocklist, err := restrictionsAPI.ListBlocklist()
		if err != nil {
			return err
		}

		type listOutput struct {
			Allowlist []*clerk.AllowlistIdentifier `json:"allowlist"`
			Blocklist []*clerk.BlocklistIdentifier `json:"blocklist"`
		}

		formatter := GetFormatter()
		return formatter.Output(listOutput{Allowlist: allowlist.AllowlistIdentifiers, Blocklist: blocklist.BlocklistIdentifiers}, func() {
			fmt.Println(output.BoldYellow("Allowlist"))
			if len(allowlist.AllowlistIdentifiers) == 0 {
				fmt.Println("  No allowlist identifiers found")
			} else {
				rows := make([][]string, len(allowlist.AllowlistIdentifiers))
				for i, id := range allowlist.AllowlistIdentifiers {
					created := time.UnixMilli(id.CreatedAt).Format("2006-01-02")
					rows[i] = []string{id.ID, id.Identifier, id.IdentifierType, created}
				}
				output.Table([]string{"ID", "IDENTIFIER", "TYPE", "CREATED"}, rows)
			}
			fmt.Println()

			fmt.Println(output.BoldYellow("Blocklist"))
			if len(blocklist.BlocklistIdentifiers) == 0 {
				fmt.Println("  No blocklist identifiers found")
			} else {
				rows := make([][]string, len(blocklist.BlocklistIdentifiers))
				for i, id := range blocklist.BlocklistIdentifiers {
					created := time.UnixMilli(id.CreatedAt).Format("2006-01-02")
					rows[i] = []string{id.ID, id.Identifier, id.IdentifierType, created}
				}
				output.Table([]string{"ID", "IDENTIFIER", "TYPE", "CREATED"}, rows)
			}
		})
	},
}

var restrictionsAddCmd = &cobra.Command{
	Use:   "add <identifier>",
	Short: "Add a restriction",
	Long: `Add an identifier to the allowlist or blocklist.

Use --allow to add to the allowlist (permits sign-up).
Use --block to add to the blocklist (prevents sign-up).`,
	Args: RequireArg("identifier"),
	RunE: func(cmd *cobra.Command, args []string) error {
		allow, _ := cmd.Flags().GetBool("allow")
		block, _ := cmd.Flags().GetBool("block")
		notify, _ := cmd.Flags().GetBool("notify")

		if !allow && !block {
			return fmt.Errorf("must specify either --allow or --block")
		}
		if allow && block {
			return fmt.Errorf("cannot specify both --allow and --block")
		}

		client, err := GetClient()
		if err != nil {
			return err
		}
		restrictionsAPI := api.NewRestrictionsAPI(client)

		var listName string

		if allow {
			params := sdkallowlist.CreateParams{
				Identifier: clerk.String(args[0]),
			}
			if notify {
				params.Notify = clerk.Bool(true)
			}

			identifier, err := restrictionsAPI.AddToAllowlist(params)
			if err != nil {
				return err
			}
			listName = "allowlist"

			formatter := GetFormatter()
			return formatter.Output(identifier, func() {
				output.Success(fmt.Sprintf("Added %s to %s", identifier.Identifier, listName))
			})
		}

		identifier, err := restrictionsAPI.AddToBlocklist(sdkblocklist.CreateParams{
			Identifier: clerk.String(args[0]),
		})
		if err != nil {
			return err
		}
		listName = "blocklist"

		formatter := GetFormatter()
		return formatter.Output(identifier, func() {
			output.Success(fmt.Sprintf("Added %s to %s", identifier.Identifier, listName))
		})
	},
}

var restrictionsRemoveCmd = &cobra.Command{
	Use:     "remove <id>",
	Aliases: []string{"rm"},
	Short:   "Remove a restriction",
	Long:    "Remove an identifier from the allowlist or blocklist by its ID.",
	Args:    RequireArg("id"),
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		restrictionsAPI := api.NewRestrictionsAPI(client)

		if err := restrictionsAPI.Remove(args[0]); err != nil {
			return err
		}

		output.Success(fmt.Sprintf("Removed %s", args[0]))
		return nil
	},
}

func init() {
	restrictionsAddCmd.Flags().Bool("allow", false, "Add to allowlist")
	restrictionsAddCmd.Flags().Bool("block", false, "Add to blocklist")
	restrictionsAddCmd.Flags().Bool("notify", false, "Send notification email (allowlist only)")

	restrictionsCmd.AddCommand(restrictionsListCmd)
	restrictionsCmd.AddCommand(restrictionsAddCmd)
	restrictionsCmd.AddCommand(restrictionsRemoveCmd)
}
