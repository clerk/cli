package cmd

import (
	"fmt"
	"time"

	"clerk.com/cli/internal/api"
	"clerk.com/cli/internal/output"
	"github.com/spf13/cobra"
)

var phonesCmd = &cobra.Command{
	Use:     "phone-numbers",
	Aliases: []string{"phones"},
	Short:   "Manage phone numbers",
	Long:    "Manage phone numbers in your Clerk instance.",
}

var phonesGetCmd = &cobra.Command{
	Use:   "get <phone-id>",
	Short: "Get phone number",
	Args:  RequireArg("phone-id"),
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		phonesAPI := api.NewPhonesAPI(client)

		phone, err := phonesAPI.Get(args[0])
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(phone, func() {
			fmt.Println(output.BoldYellow("Phone Number:"), phone.ID)
			fmt.Println(output.Dim("Number:"), phone.PhoneNumber)
			fmt.Println(output.Dim("Verified:"), phone.Verified)
			fmt.Println(output.Dim("Created:"), time.UnixMilli(phone.CreatedAt).Format(time.RFC3339))
		})
	},
}

var phonesCreateCmd = &cobra.Command{
	Use:   "create",
	Short: "Create phone number",
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		phonesAPI := api.NewPhonesAPI(client)

		userID, _ := cmd.Flags().GetString("user-id")
		number, _ := cmd.Flags().GetString("phone")
		verified, _ := cmd.Flags().GetBool("verified")
		primary, _ := cmd.Flags().GetBool("primary")

		if userID == "" || number == "" {
			return fmt.Errorf("--user-id and --phone are required")
		}

		phone, err := phonesAPI.Create(api.CreatePhoneParams{
			UserID:      userID,
			PhoneNumber: number,
			Verified:    verified,
			Primary:     primary,
		})
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(phone, func() {
			output.Success(fmt.Sprintf("Created phone number %s", phone.ID))
		})
	},
}

var phonesUpdateCmd = &cobra.Command{
	Use:   "update <phone-id>",
	Short: "Update phone number",
	Args:  RequireArg("phone-id"),
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		phonesAPI := api.NewPhonesAPI(client)

		verified, _ := cmd.Flags().GetBool("verified")
		primary, _ := cmd.Flags().GetBool("primary")

		phone, err := phonesAPI.Update(args[0], api.UpdatePhoneParams{
			Verified: verified,
			Primary:  primary,
		})
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(phone, func() {
			output.Success(fmt.Sprintf("Updated phone number %s", phone.ID))
		})
	},
}

var phonesDeleteCmd = &cobra.Command{
	Use:   "delete <phone-id>",
	Short: "Delete phone number",
	Args:  RequireArg("phone-id"),
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		phonesAPI := api.NewPhonesAPI(client)

		if err := phonesAPI.Delete(args[0]); err != nil {
			return err
		}

		output.Success(fmt.Sprintf("Deleted phone number %s", args[0]))
		return nil
	},
}

func init() {
	phonesCreateCmd.Flags().String("user-id", "", "User ID")
	phonesCreateCmd.Flags().String("phone", "", "Phone number")
	phonesCreateCmd.Flags().Bool("verified", false, "Mark as verified")
	phonesCreateCmd.Flags().Bool("primary", false, "Set as primary")

	phonesUpdateCmd.Flags().Bool("verified", false, "Mark as verified")
	phonesUpdateCmd.Flags().Bool("primary", false, "Set as primary")

	phonesCmd.AddCommand(phonesGetCmd)
	phonesCmd.AddCommand(phonesCreateCmd)
	phonesCmd.AddCommand(phonesUpdateCmd)
	phonesCmd.AddCommand(phonesDeleteCmd)
}
