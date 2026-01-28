package cmd

import (
	"fmt"
	"time"

	"clerk.com/cli/internal/api"
	"clerk.com/cli/internal/output"
	"github.com/spf13/cobra"
)

var usersPhonesCmd = &cobra.Command{
	Use:     "phones",
	Aliases: []string{"phone"},
	Short:   "User phone numbers",
	Long:    "Manage phone numbers for users in your Clerk instance.",
}

var usersPhonesListCmd = &cobra.Command{
	Use:   "list <user-id>",
	Short: "List phone numbers for a user",
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
		return formatter.Output(user.PhoneNumbers, func() {
			if len(user.PhoneNumbers) == 0 {
				fmt.Println("No phone numbers found")
				return
			}

			rows := make([][]string, len(user.PhoneNumbers))
			for i, p := range user.PhoneNumbers {
				primary := ""
				if p.ID == user.PrimaryPhoneID {
					primary = "yes"
				}
				verified := "no"
				if p.Verified {
					verified = "yes"
				}
				rows[i] = []string{p.ID, p.PhoneNumber, verified, primary}
			}
			output.Table([]string{"ID", "PHONE", "VERIFIED", "PRIMARY"}, rows)
		})
	},
}

var usersPhonesGetCmd = &cobra.Command{
	Use:   "get <phone-id>",
	Short: "Get phone number details",
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

var usersPhonesAddCmd = &cobra.Command{
	Use:   "add <user-id>",
	Short: "Add phone number to a user",
	Args:  RequireArg("user-id"),
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		phonesAPI := api.NewPhonesAPI(client)

		number, _ := cmd.Flags().GetString("phone")
		verified, _ := cmd.Flags().GetBool("verified")
		primary, _ := cmd.Flags().GetBool("primary")

		if number == "" {
			return fmt.Errorf("--phone is required")
		}

		phone, err := phonesAPI.Create(api.CreatePhoneParams{
			UserID:      args[0],
			PhoneNumber: number,
			Verified:    verified,
			Primary:     primary,
		})
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(phone, func() {
			output.Success(fmt.Sprintf("Added phone number %s", phone.ID))
		})
	},
}

var usersPhonesUpdateCmd = &cobra.Command{
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

var usersPhonesRemoveCmd = &cobra.Command{
	Use:   "remove <phone-id>",
	Short: "Remove phone number",
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

		output.Success(fmt.Sprintf("Removed phone number %s", args[0]))
		return nil
	},
}

func init() {
	usersPhonesAddCmd.Flags().String("phone", "", "Phone number")
	usersPhonesAddCmd.Flags().Bool("verified", false, "Mark as verified")
	usersPhonesAddCmd.Flags().Bool("primary", false, "Set as primary")

	usersPhonesUpdateCmd.Flags().Bool("verified", false, "Mark as verified")
	usersPhonesUpdateCmd.Flags().Bool("primary", false, "Set as primary")

	usersPhonesCmd.AddCommand(usersPhonesListCmd)
	usersPhonesCmd.AddCommand(usersPhonesGetCmd)
	usersPhonesCmd.AddCommand(usersPhonesAddCmd)
	usersPhonesCmd.AddCommand(usersPhonesUpdateCmd)
	usersPhonesCmd.AddCommand(usersPhonesRemoveCmd)
}
