package cmd

import (
	"fmt"
	"time"

	"clerk.com/cli/internal/api"
	"clerk.com/cli/internal/output"
	"github.com/AlecAivazis/survey/v2"
	"github.com/spf13/cobra"
)

var sessionsCmd = &cobra.Command{
	Use:   "sessions",
	Short: "Manage sessions",
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

		sessions, total, err := sessionsAPI.List(api.ListSessionsParams{
			UserID:   userID,
			ClientID: clientID,
			Status:   status,
			Limit:    limit,
			Offset:   offset,
		})
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(map[string]interface{}{
			"data":        sessions,
			"total_count": total,
		}, func() {
			if len(sessions) == 0 {
				fmt.Println("No sessions found")
				return
			}

			rows := make([][]string, len(sessions))
			for i, s := range sessions {
				lastActive := time.UnixMilli(s.LastActiveAt).Format("2006-01-02 15:04")
				rows[i] = []string{s.ID, s.UserID, s.Status, lastActive}
			}
			output.Table([]string{"ID", "USER ID", "STATUS", "LAST ACTIVE"}, rows)
			fmt.Printf("\nTotal: %d\n", total)
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
			prompt := &survey.Confirm{
				Message: fmt.Sprintf("Revoke session %s?", args[0]),
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
