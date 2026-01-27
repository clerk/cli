package cmd

import (
	"fmt"
	"strings"
	"time"

	"clerk.com/cli/internal/api"
	"clerk.com/cli/internal/output"
	"github.com/spf13/cobra"
)

var invitationsCmd = &cobra.Command{
	Use:     "invitations",
	Aliases: []string{"invites"},
	Short:   "Manage invitations",
	Long:    "Manage invitations in your Clerk instance.",
}

var invitationsListCmd = &cobra.Command{
	Use:     "list",
	Aliases: []string{"ls"},
	Short:   "List invitations",
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		invitationsAPI := api.NewInvitationsAPI(client)

		status, _ := cmd.Flags().GetString("status")
		limit, _ := cmd.Flags().GetInt("limit")
		offset, _ := cmd.Flags().GetInt("offset")

		invitations, total, err := invitationsAPI.List(api.ListInvitationsParams{
			Status: status,
			Limit:  limit,
			Offset: offset,
		})
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(map[string]interface{}{
			"data":        invitations,
			"total_count": total,
		}, func() {
			if len(invitations) == 0 {
				fmt.Println("No invitations found")
				return
			}

			rows := make([][]string, len(invitations))
			for i, inv := range invitations {
				created := time.UnixMilli(inv.CreatedAt).Format("2006-01-02")
				rows[i] = []string{inv.ID, inv.EmailAddress, inv.Status, created}
			}
			output.Table([]string{"ID", "EMAIL", "STATUS", "CREATED"}, rows)
			fmt.Printf("\nTotal: %d\n", total)
		})
	},
}

var invitationsCreateCmd = &cobra.Command{
	Use:   "create",
	Short: "Create invitation",
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		invitationsAPI := api.NewInvitationsAPI(client)

		email, _ := cmd.Flags().GetString("email")
		redirectURL, _ := cmd.Flags().GetString("redirect-url")
		notify, _ := cmd.Flags().GetBool("notify")

		if email == "" {
			return fmt.Errorf("--email is required")
		}

		invitation, err := invitationsAPI.Create(api.CreateInvitationParams{
			EmailAddress: email,
			RedirectURL:  redirectURL,
			Notify:       notify,
		})
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(invitation, func() {
			output.Success(fmt.Sprintf("Created invitation %s", invitation.ID))
			if invitation.URL != "" {
				fmt.Println(output.Dim("URL:"), invitation.URL)
			}
		})
	},
}

var invitationsBulkCreateCmd = &cobra.Command{
	Use:   "bulk-create",
	Short: "Bulk create invitations",
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		invitationsAPI := api.NewInvitationsAPI(client)

		emailsStr, _ := cmd.Flags().GetString("emails")
		redirectURL, _ := cmd.Flags().GetString("redirect-url")
		notify, _ := cmd.Flags().GetBool("notify")
		ignoreExisting, _ := cmd.Flags().GetBool("ignore-existing")

		if emailsStr == "" {
			return fmt.Errorf("--emails is required")
		}

		emails := strings.Split(emailsStr, ",")
		for i := range emails {
			emails[i] = strings.TrimSpace(emails[i])
		}

		invitations, err := invitationsAPI.BulkCreate(api.BulkCreateInvitationsParams{
			EmailAddresses: emails,
			RedirectURL:    redirectURL,
			Notify:         notify,
			IgnoreExisting: ignoreExisting,
		})
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(invitations, func() {
			output.Success(fmt.Sprintf("Created %d invitations", len(invitations)))
		})
	},
}

var invitationsRevokeCmd = &cobra.Command{
	Use:   "revoke <invitation-id>",
	Short: "Revoke invitation",
	Args:  RequireArg("invitation-id"),
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		invitationsAPI := api.NewInvitationsAPI(client)

		invitation, err := invitationsAPI.Revoke(args[0])
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(invitation, func() {
			output.Success(fmt.Sprintf("Revoked invitation %s", invitation.ID))
		})
	},
}

func init() {
	invitationsListCmd.Flags().String("status", "", "Filter by status")
	invitationsListCmd.Flags().Int("limit", 10, "Number of results to return")
	invitationsListCmd.Flags().Int("offset", 0, "Offset for pagination")

	invitationsCreateCmd.Flags().String("email", "", "Email address")
	invitationsCreateCmd.Flags().String("redirect-url", "", "Redirect URL after accepting")
	invitationsCreateCmd.Flags().Bool("notify", true, "Send email notification")

	invitationsBulkCreateCmd.Flags().String("emails", "", "Comma-separated email addresses")
	invitationsBulkCreateCmd.Flags().String("redirect-url", "", "Redirect URL after accepting")
	invitationsBulkCreateCmd.Flags().Bool("notify", true, "Send email notifications")
	invitationsBulkCreateCmd.Flags().Bool("ignore-existing", false, "Ignore existing users")

	invitationsCmd.AddCommand(invitationsListCmd)
	invitationsCmd.AddCommand(invitationsCreateCmd)
	invitationsCmd.AddCommand(invitationsBulkCreateCmd)
	invitationsCmd.AddCommand(invitationsRevokeCmd)
}
