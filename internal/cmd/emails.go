package cmd

import (
	"fmt"
	"time"

	"clerk.com/cli/internal/api"
	"clerk.com/cli/internal/output"
	"github.com/spf13/cobra"
)

var emailsCmd = &cobra.Command{
	Use:     "email-addresses",
	Aliases: []string{"emails"},
	Short:   "Manage email addresses",
	Long:    "Manage email addresses in your Clerk instance.",
}

var emailsGetCmd = &cobra.Command{
	Use:   "get <email-id>",
	Short: "Get email address",
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

var emailsCreateCmd = &cobra.Command{
	Use:   "create",
	Short: "Create email address",
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		emailsAPI := api.NewEmailsAPI(client)

		userID, _ := cmd.Flags().GetString("user-id")
		address, _ := cmd.Flags().GetString("email")
		verified, _ := cmd.Flags().GetBool("verified")
		primary, _ := cmd.Flags().GetBool("primary")

		if userID == "" || address == "" {
			return fmt.Errorf("--user-id and --email are required")
		}

		email, err := emailsAPI.Create(api.CreateEmailParams{
			UserID:       userID,
			EmailAddress: address,
			Verified:     verified,
			Primary:      primary,
		})
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(email, func() {
			output.Success(fmt.Sprintf("Created email address %s", email.ID))
		})
	},
}

var emailsUpdateCmd = &cobra.Command{
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

var emailsDeleteCmd = &cobra.Command{
	Use:   "delete <email-id>",
	Short: "Delete email address",
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

		output.Success(fmt.Sprintf("Deleted email address %s", args[0]))
		return nil
	},
}

func init() {
	emailsCreateCmd.Flags().String("user-id", "", "User ID")
	emailsCreateCmd.Flags().String("email", "", "Email address")
	emailsCreateCmd.Flags().Bool("verified", false, "Mark as verified")
	emailsCreateCmd.Flags().Bool("primary", false, "Set as primary")

	emailsUpdateCmd.Flags().Bool("verified", false, "Mark as verified")
	emailsUpdateCmd.Flags().Bool("primary", false, "Set as primary")

	emailsCmd.AddCommand(emailsGetCmd)
	emailsCmd.AddCommand(emailsCreateCmd)
	emailsCmd.AddCommand(emailsUpdateCmd)
	emailsCmd.AddCommand(emailsDeleteCmd)
}
