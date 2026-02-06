package cmd

import (
	"fmt"
	"time"

	"github.com/charmbracelet/huh"
	clerk "github.com/clerk/clerk-sdk-go/v2"
	sdksession "github.com/clerk/clerk-sdk-go/v2/session"
	"github.com/spf13/cobra"

	"clerk.com/cli/internal/api"
	"clerk.com/cli/internal/output"
)

var sessionsCmd = &cobra.Command{
	Use:   "sessions",
	Short: "User sessions",
	Long:  "Manage sessions in your Clerk instance.",
}

var sessionsListCmd = &cobra.Command{
	Use:     "list",
	Aliases: []string{"ls"},
	Short:   "List sessions",
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		sessionsAPI := api.NewSessionsAPI(client)

		userID, _ := cmd.Flags().GetString("user-id")
		clientID, _ := cmd.Flags().GetString("client-id")
		status, _ := cmd.Flags().GetString("status")
		limit, _ := cmd.Flags().GetInt("limit")
		offset, _ := cmd.Flags().GetInt("offset")

		if userID == "" && clientID == "" {
			return fmt.Errorf("either --user-id or --client-id is required")
		}

		params := sdksession.ListParams{}
		if userID != "" {
			params.UserID = clerk.String(userID)
		}
		if clientID != "" {
			params.ClientID = clerk.String(clientID)
		}
		if status != "" {
			params.Status = clerk.String(status)
		}
		if limit > 0 {
			params.Limit = clerk.Int64(int64(limit))
		}
		if offset > 0 {
			params.Offset = clerk.Int64(int64(offset))
		}

		result, err := sessionsAPI.List(params)
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(result, func() {
			if len(result.Sessions) == 0 {
				fmt.Println("No sessions found")
				return
			}

			rows := make([][]string, len(result.Sessions))
			for i, s := range result.Sessions {
				lastActive := time.UnixMilli(s.LastActiveAt).Format("2006-01-02 15:04")
				rows[i] = []string{s.ID, s.UserID, s.Status, lastActive}
			}
			output.Table([]string{"ID", "USER ID", "STATUS", "LAST ACTIVE"}, rows)
			fmt.Printf("\nTotal: %d\n", result.TotalCount)
		})
	},
}

var sessionsGetCmd = &cobra.Command{
	Use:   "get <session-id>",
	Short: "Get session",
	Args:  RequireArg("session-id"),
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		sessionsAPI := api.NewSessionsAPI(client)

		session, err := sessionsAPI.Get(args[0])
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(session, func() {
			fmt.Println(output.BoldYellow("Session:"), session.ID)
			fmt.Println(output.Dim("User ID:"), session.UserID)
			fmt.Println(output.Dim("Client ID:"), session.ClientID)
			fmt.Println(output.Dim("Status:"), session.Status)
			fmt.Println(output.Dim("Last Active:"), time.UnixMilli(session.LastActiveAt).Format(time.RFC3339))
			fmt.Println(output.Dim("Expires:"), time.UnixMilli(session.ExpireAt).Format(time.RFC3339))
		})
	},
}

var sessionsRevokeCmd = &cobra.Command{
	Use:   "revoke <session-id>",
	Short: "Revoke session",
	Args:  RequireArg("session-id"),
	RunE: func(cmd *cobra.Command, args []string) error {
		force, _ := cmd.Flags().GetBool("force")
		if !force && output.IsInteractive() {
			var confirm bool
			err := huh.NewConfirm().
				Title(fmt.Sprintf("Revoke session %s?", args[0])).
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

		client, err := GetClient()
		if err != nil {
			return err
		}
		sessionsAPI := api.NewSessionsAPI(client)

		session, err := sessionsAPI.Revoke(args[0])
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(session, func() {
			output.Success(fmt.Sprintf("Revoked session %s", session.ID))
		})
	},
}

func init() {
	sessionsListCmd.Flags().String("user-id", "", "Filter by user ID")
	sessionsListCmd.Flags().String("client-id", "", "Filter by client ID")
	sessionsListCmd.Flags().String("status", "", "Filter by status")
	sessionsListCmd.Flags().Int("limit", 10, "Number of results to return")
	sessionsListCmd.Flags().Int("offset", 0, "Offset for pagination")

	sessionsRevokeCmd.Flags().BoolP("force", "f", false, "Skip confirmation prompt")

	sessionsCmd.AddCommand(sessionsListCmd)
	sessionsCmd.AddCommand(sessionsGetCmd)
	sessionsCmd.AddCommand(sessionsRevokeCmd)
}
