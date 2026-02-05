package cmd

import (
	"fmt"
	"time"

	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"

	"clerk.com/cli/internal/api"
	"clerk.com/cli/internal/output"
)

var transfersCmd = &cobra.Command{
	Use:   "transfers",
	Short: "Manage application transfers",
	Long:  "Manage application transfers between workspaces using the Platform API.",
}

var transfersListCmd = &cobra.Command{
	Use:     "list",
	Aliases: []string{"ls"},
	Short:   "List transfers",
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetPlatformClient()
		if err != nil {
			return err
		}
		transfersAPI := api.NewTransfersAPI(client)

		limit, _ := cmd.Flags().GetInt("limit")
		offset, _ := cmd.Flags().GetInt("offset")
		status, _ := cmd.Flags().GetString("status")

		transfers, total, err := transfersAPI.List(api.ListTransfersParams{
			Limit:  limit,
			Offset: offset,
			Status: status,
		})
		if err != nil {
			return err
		}

		formatter := GetFormatter()

		return formatter.Output(map[string]any{
			"data":        transfers,
			"total_count": total,
		}, func() {
			if len(transfers) == 0 {
				fmt.Println("No transfers found")
				return
			}

			rows := make([][]string, len(transfers))
			for i, t := range transfers {
				created := time.UnixMilli(t.CreatedAt).Format("2006-01-02")
				rows[i] = []string{t.ID, t.ApplicationID, t.Status, created}
			}
			output.Table([]string{"ID", "APPLICATION", "STATUS", "CREATED"}, rows)
			fmt.Printf("\nTotal: %d\n", total)
		})
	},
}

var transfersGetCmd = &cobra.Command{
	Use:   "get <transfer-id>",
	Short: "Get transfer details",
	Args:  RequireArg("transfer-id"),
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetPlatformClient()
		if err != nil {
			return err
		}
		transfersAPI := api.NewTransfersAPI(client)

		transfer, err := transfersAPI.Get(args[0])
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(transfer, func() {
			fmt.Println(output.BoldYellow("Transfer:"), transfer.ID)
			fmt.Println(output.Dim("Application:"), transfer.ApplicationID)
			fmt.Println(output.Dim("Source Workspace:"), transfer.SourceWorkspace)
			fmt.Println(output.Dim("Target Workspace:"), transfer.TargetWorkspace)
			fmt.Println(output.Dim("Status:"), transfer.Status)
			if transfer.ExpiresAt > 0 {
				fmt.Println(output.Dim("Expires:"), time.UnixMilli(transfer.ExpiresAt).Format(time.RFC3339))
			}
			fmt.Println(output.Dim("Created:"), time.UnixMilli(transfer.CreatedAt).Format(time.RFC3339))
			fmt.Println(output.Dim("Updated:"), time.UnixMilli(transfer.UpdatedAt).Format(time.RFC3339))
		})
	},
}

var transfersCreateCmd = &cobra.Command{
	Use:   "create",
	Short: "Create a transfer",
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetPlatformClient()
		if err != nil {
			return err
		}
		transfersAPI := api.NewTransfersAPI(client)

		appID, _ := cmd.Flags().GetString("app-id")
		targetWorkspace, _ := cmd.Flags().GetString("target-workspace")

		if appID == "" {
			return fmt.Errorf("--app-id is required")
		}
		if targetWorkspace == "" {
			return fmt.Errorf("--target-workspace is required")
		}

		transfer, err := transfersAPI.Create(api.CreateTransferParams{
			ApplicationID:   appID,
			TargetWorkspace: targetWorkspace,
		})
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(transfer, func() {
			output.Success(fmt.Sprintf("Created transfer %s", transfer.ID))
		})
	},
}

var transfersAcceptCmd = &cobra.Command{
	Use:   "accept <transfer-id>",
	Short: "Accept a pending transfer",
	Args:  RequireArg("transfer-id"),
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetPlatformClient()
		if err != nil {
			return err
		}
		transfersAPI := api.NewTransfersAPI(client)

		transfer, err := transfersAPI.Accept(args[0])
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(transfer, func() {
			output.Success(fmt.Sprintf("Accepted transfer %s", transfer.ID))
		})
	},
}

var transfersCancelCmd = &cobra.Command{
	Use:   "cancel <transfer-id>",
	Short: "Cancel a pending transfer",
	Args:  RequireArg("transfer-id"),
	RunE: func(cmd *cobra.Command, args []string) error {
		force, _ := cmd.Flags().GetBool("force")
		if !force && output.IsInteractive() {
			var confirm bool
			err := huh.NewConfirm().
				Title(fmt.Sprintf("Cancel transfer %s?", args[0])).
				Value(&confirm).
				Run()
			if err != nil {
				return err
			}
			if !confirm {
				fmt.Println("Canceled")
				return nil
			}
		}

		client, err := GetPlatformClient()
		if err != nil {
			return err
		}
		transfersAPI := api.NewTransfersAPI(client)

		transfer, err := transfersAPI.Cancel(args[0])
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(transfer, func() {
			output.Success(fmt.Sprintf("Canceled transfer %s", transfer.ID))
		})
	},
}

func init() {
	transfersListCmd.Flags().Int("limit", 10, "Number of results to return")
	transfersListCmd.Flags().Int("offset", 0, "Offset for pagination")
	transfersListCmd.Flags().String("status", "", "Filter by status (pending, accepted, canceled, expired)")

	transfersCreateCmd.Flags().String("app-id", "", "Application ID (required)")
	transfersCreateCmd.Flags().String("target-workspace", "", "Target workspace ID (required)")

	transfersCancelCmd.Flags().BoolP("force", "f", false, "Skip confirmation prompt")

	transfersCmd.AddCommand(transfersListCmd)
	transfersCmd.AddCommand(transfersGetCmd)
	transfersCmd.AddCommand(transfersCreateCmd)
	transfersCmd.AddCommand(transfersAcceptCmd)
	transfersCmd.AddCommand(transfersCancelCmd)
}
