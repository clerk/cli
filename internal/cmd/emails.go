package cmd

import (
	"fmt"
	"time"

	"github.com/spf13/cobra"

	"clerk.com/cli/internal/api"
	"clerk.com/cli/internal/output"
)

var usersEmailsCmd = &cobra.Command{
	Use:     "emails",
	Aliases: []string{"email"},
	Short:   "User email addresses",
	Long:    "Manage email addresses for users in your Clerk instance.",
}

var usersEmailsListCmd = &cobra.Command{
	Use:   "list <user-id>",
	Short: "List email addresses for a user",
	Args:  RequireArg("user-id"),
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		usersAPI := api.NewUsersAPI(client)

		user, err := usersAPI.Get(args[0])
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(user.EmailAddresses, func() {
			if len(user.EmailAddresses) == 0 {
				fmt.Println("No email addresses found")
				return
			}

			rows := make([][]string, len(user.EmailAddresses))
			for i, e := range user.EmailAddresses {
				primary := ""
				if e.ID == user.PrimaryEmailID {
					primary = "yes"
				}
				verified := "no"
				if e.Verified {
					verified = "yes"
				}
				rows[i] = []string{e.ID, e.EmailAddress, verified, primary}
			}
			output.Table([]string{"ID", "EMAIL", "VERIFIED", "PRIMARY"}, rows)
		})
	},
}

var usersEmailsGetCmd = &cobra.Command{
	Use:   "get <email-id>",
	Short: "Get email address details",
	Args:  RequireArg("email-id"),
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		emailsAPI := api.NewEmailsAPI(client)

		email, err := emailsAPI.Get(args[0])
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(email, func() {
			fmt.Println(output.BoldYellow("Email Address:"), email.ID)
			fmt.Println(output.Dim("Address:"), email.EmailAddress)
			fmt.Println(output.Dim("Verified:"), email.Verified)
			fmt.Println(output.Dim("Created:"), time.UnixMilli(email.CreatedAt).Format(time.RFC3339))
		})
	},
}

var usersEmailsAddCmd = &cobra.Command{
	Use:   "add <user-id>",
	Short: "Add email address to a user",
	Args:  RequireArg("user-id"),
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		emailsAPI := api.NewEmailsAPI(client)

		address, _ := cmd.Flags().GetString("email")
		verified, _ := cmd.Flags().GetBool("verified")
		primary, _ := cmd.Flags().GetBool("primary")

		if address == "" {
			return fmt.Errorf("--email is required")
		}

		email, err := emailsAPI.Create(api.CreateEmailParams{
			UserID:       args[0],
			EmailAddress: address,
			Verified:     verified,
			Primary:      primary,
		})
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(email, func() {
			output.Success(fmt.Sprintf("Added email address %s", email.ID))
		})
	},
}

var usersEmailsUpdateCmd = &cobra.Command{
	Use:   "update <email-id>",
	Short: "Update email address",
	Args:  RequireArg("email-id"),
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		emailsAPI := api.NewEmailsAPI(client)

		verified, _ := cmd.Flags().GetBool("verified")
		primary, _ := cmd.Flags().GetBool("primary")

		email, err := emailsAPI.Update(args[0], api.UpdateEmailParams{
			Verified: verified,
			Primary:  primary,
		})
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(email, func() {
			output.Success(fmt.Sprintf("Updated email address %s", email.ID))
		})
	},
}

var usersEmailsRemoveCmd = &cobra.Command{
	Use:   "remove <email-id>",
	Short: "Remove email address",
	Args:  RequireArg("email-id"),
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		emailsAPI := api.NewEmailsAPI(client)

		if err := emailsAPI.Delete(args[0]); err != nil {
			return err
		}

		output.Success(fmt.Sprintf("Removed email address %s", args[0]))
		return nil
	},
}

func init() {
	usersEmailsAddCmd.Flags().String("email", "", "Email address")
	usersEmailsAddCmd.Flags().Bool("verified", false, "Mark as verified")
	usersEmailsAddCmd.Flags().Bool("primary", false, "Set as primary")

	usersEmailsUpdateCmd.Flags().Bool("verified", false, "Mark as verified")
	usersEmailsUpdateCmd.Flags().Bool("primary", false, "Set as primary")

	usersEmailsCmd.AddCommand(usersEmailsListCmd)
	usersEmailsCmd.AddCommand(usersEmailsGetCmd)
	usersEmailsCmd.AddCommand(usersEmailsAddCmd)
	usersEmailsCmd.AddCommand(usersEmailsUpdateCmd)
	usersEmailsCmd.AddCommand(usersEmailsRemoveCmd)
}
