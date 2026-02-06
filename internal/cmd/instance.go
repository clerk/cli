package cmd

import (
	"fmt"
	"strings"

	clerk "github.com/clerk/clerk-sdk-go/v2"
	sdkinstance "github.com/clerk/clerk-sdk-go/v2/instancesettings"
	"github.com/spf13/cobra"

	"clerk.com/cli/internal/api"
	"clerk.com/cli/internal/output"
)

var instanceCmd = &cobra.Command{
	Use:   "instance",
	Short: "Instance settings",
	Long:  "Manage instance settings for your Clerk instance.",
}

var instanceGetCmd = &cobra.Command{
	Use:   "get",
	Short: "Get instance info",
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		instanceAPI := api.NewInstanceAPI(client)

		instance, err := instanceAPI.Get()
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(instance, func() {
			fmt.Println(output.BoldYellow("Instance:"), instance.ID)
			fmt.Println(output.Dim("Environment:"), instance.EnvironmentType)
			if instance.HomeOrigin != "" {
				fmt.Println(output.Dim("Home Origin:"), instance.HomeOrigin)
			}
			if instance.SupportEmail != "" {
				fmt.Println(output.Dim("Support Email:"), instance.SupportEmail)
			}
			fmt.Println(output.Dim("Maintenance Mode:"), instance.MaintenanceMode)
			if len(instance.AllowedOrigins) > 0 {
				fmt.Println(output.Dim("Allowed Origins:"), strings.Join(instance.AllowedOrigins, ", "))
			}
		})
	},
}

var instanceUpdateCmd = &cobra.Command{
	Use:   "update",
	Short: "Update instance settings",
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		instanceAPI := api.NewInstanceAPI(client)

		supportEmail, _ := cmd.Flags().GetString("support-email")
		clerkJSVersion, _ := cmd.Flags().GetString("clerk-js-version")
		_, _ = cmd.Flags().GetString("allowed-origins")

		params := sdkinstance.UpdateParams{}
		if supportEmail != "" {
			params.SupportEmail = clerk.String(supportEmail)
		}
		if clerkJSVersion != "" {
			params.ClerkJSVersion = clerk.String(clerkJSVersion)
		}

		if err := instanceAPI.Update(params); err != nil {
			return err
		}

		output.Success("Updated instance settings")
		return nil
	},
}

var instanceRestrictionsCmd = &cobra.Command{
	Use:   "restrictions",
	Short: "Manage instance restrictions",
}

var instanceRestrictionsUpdateCmd = &cobra.Command{
	Use:   "update",
	Short: "Update restrictions",
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		instanceAPI := api.NewInstanceAPI(client)

		params := sdkinstance.UpdateRestrictionsParams{}

		if cmd.Flags().Changed("allowlist") {
			val, _ := cmd.Flags().GetBool("allowlist")
			params.Allowlist = clerk.Bool(val)
		}
		if cmd.Flags().Changed("blocklist") {
			val, _ := cmd.Flags().GetBool("blocklist")
			params.Blocklist = clerk.Bool(val)
		}
		if cmd.Flags().Changed("block-disposable") {
			val, _ := cmd.Flags().GetBool("block-disposable")
			params.BlockDisposableEmailDomains = clerk.Bool(val)
		}
		if cmd.Flags().Changed("block-subaddresses") {
			val, _ := cmd.Flags().GetBool("block-subaddresses")
			params.BlockEmailSubaddresses = clerk.Bool(val)
		}

		restrictions, err := instanceAPI.UpdateRestrictions(params)
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(restrictions, func() {
			output.Success("Updated instance restrictions")
		})
	},
}

func init() {
	instanceUpdateCmd.Flags().String("support-email", "", "Support email")
	instanceUpdateCmd.Flags().String("clerk-js-version", "", "Clerk.js version")
	instanceUpdateCmd.Flags().String("allowed-origins", "", "Comma-separated allowed origins")

	instanceRestrictionsUpdateCmd.Flags().Bool("allowlist", false, "Enable allowlist")
	instanceRestrictionsUpdateCmd.Flags().Bool("blocklist", false, "Enable blocklist")
	instanceRestrictionsUpdateCmd.Flags().Bool("block-disposable", false, "Block disposable emails")
	instanceRestrictionsUpdateCmd.Flags().Bool("block-subaddresses", false, "Block email subaddresses")

	instanceRestrictionsCmd.AddCommand(instanceRestrictionsUpdateCmd)

	instanceCmd.AddCommand(instanceGetCmd)
	instanceCmd.AddCommand(instanceUpdateCmd)
	instanceCmd.AddCommand(instanceRestrictionsCmd)
}
