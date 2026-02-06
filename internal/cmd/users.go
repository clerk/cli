package cmd

import (
	"fmt"
	"time"

	"github.com/charmbracelet/huh"
	clerk "github.com/clerk/clerk-sdk-go/v2"
	sdkuser "github.com/clerk/clerk-sdk-go/v2/user"
	"github.com/spf13/cobra"

	"clerk.com/cli/internal/api"
	"clerk.com/cli/internal/output"
)

var usersCmd = &cobra.Command{
	Use:   "users",
	Short: "Users and accounts",
	Long:  "Manage users in your Clerk instance.",
}

var usersListCmd = &cobra.Command{
	Use:     "list",
	Aliases: []string{"ls"},
	Short:   "List users",
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		usersAPI := api.NewUsersAPI(client)

		limit, _ := cmd.Flags().GetInt("limit")
		offset, _ := cmd.Flags().GetInt("offset")
		query, _ := cmd.Flags().GetString("query")
		orderBy, _ := cmd.Flags().GetString("order-by")
		emails, _ := cmd.Flags().GetStringSlice("email")
		phones, _ := cmd.Flags().GetStringSlice("phone")
		usernames, _ := cmd.Flags().GetStringSlice("username")
		externalIDs, _ := cmd.Flags().GetStringSlice("external-id")
		userIDs, _ := cmd.Flags().GetStringSlice("user-id")
		orgIDs, _ := cmd.Flags().GetStringSlice("organization-id")
		lastActiveSince, _ := cmd.Flags().GetInt64("last-active-since")

		params := sdkuser.ListParams{}
		if limit > 0 {
			params.Limit = clerk.Int64(int64(limit))
		}
		if offset > 0 {
			params.Offset = clerk.Int64(int64(offset))
		}
		if query != "" {
			params.Query = clerk.String(query)
		}
		if orderBy != "" {
			params.OrderBy = clerk.String(orderBy)
		}
		if len(emails) > 0 {
			params.EmailAddresses = emails
		}
		if len(phones) > 0 {
			params.PhoneNumbers = phones
		}
		if len(usernames) > 0 {
			params.Usernames = usernames
		}
		if len(externalIDs) > 0 {
			params.ExternalIDs = externalIDs
		}
		if len(userIDs) > 0 {
			params.UserIDs = userIDs
		}
		if len(orgIDs) > 0 {
			params.OrganizationIDs = orgIDs
		}
		if lastActiveSince > 0 {
			params.LastActiveAtAfter = clerk.Int64(lastActiveSince)
		}

		result, err := usersAPI.List(params)
		if err != nil {
			return err
		}

		formatter := GetFormatter()

		return formatter.Output(result, func() {
			if len(result.Users) == 0 {
				fmt.Println("No users found")
				return
			}

			rows := make([][]string, len(result.Users))
			for i, u := range result.Users {
				email := ""
				if len(u.EmailAddresses) > 0 {
					email = u.EmailAddresses[0].EmailAddress
				}
				name := fmt.Sprintf("%s %s", api.StrVal(u.FirstName), api.StrVal(u.LastName))
				created := time.UnixMilli(u.CreatedAt).Format("2006-01-02")
				rows[i] = []string{u.ID, name, email, created}
			}
			output.Table([]string{"ID", "NAME", "EMAIL", "CREATED"}, rows)
			fmt.Printf("\nTotal: %d\n", result.TotalCount)
		})
	},
}

var usersCountCmd = &cobra.Command{
	Use:   "count",
	Short: "Count users",
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		usersAPI := api.NewUsersAPI(client)

		query, _ := cmd.Flags().GetString("query")

		params := sdkuser.ListParams{}
		if query != "" {
			params.Query = clerk.String(query)
		}

		count, err := usersAPI.Count(params)
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(map[string]int64{"count": count}, func() {
			fmt.Printf("Total users: %d\n", count)
		})
	},
}

var usersGetCmd = &cobra.Command{
	Use:   "get <user-id>",
	Short: "Get user details",
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
		return formatter.Output(user, func() {
			fmt.Println(output.BoldYellow("User:"), user.ID)
			fmt.Println(output.Dim("Name:"), fmt.Sprintf("%s %s", api.StrVal(user.FirstName), api.StrVal(user.LastName)))
			if api.StrVal(user.Username) != "" {
				fmt.Println(output.Dim("Username:"), api.StrVal(user.Username))
			}
			if len(user.EmailAddresses) > 0 {
				fmt.Println(output.Dim("Email:"), user.EmailAddresses[0].EmailAddress)
			}
			fmt.Println(output.Dim("Banned:"), user.Banned)
			fmt.Println(output.Dim("Locked:"), user.Locked)
			fmt.Println(output.Dim("Created:"), time.UnixMilli(user.CreatedAt).Format(time.RFC3339))
		})
	},
}

var usersCreateCmd = &cobra.Command{
	Use:   "create",
	Short: "Create user",
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		usersAPI := api.NewUsersAPI(client)

		email, _ := cmd.Flags().GetString("email")
		firstName, _ := cmd.Flags().GetString("first-name")
		lastName, _ := cmd.Flags().GetString("last-name")
		username, _ := cmd.Flags().GetString("username")
		password, _ := cmd.Flags().GetString("password")

		var emails []string
		if email != "" {
			emails = []string{email}
		}

		params := sdkuser.CreateParams{}
		if len(emails) > 0 {
			params.EmailAddresses = &emails
		}
		if firstName != "" {
			params.FirstName = clerk.String(firstName)
		}
		if lastName != "" {
			params.LastName = clerk.String(lastName)
		}
		if username != "" {
			params.Username = clerk.String(username)
		}
		if password != "" {
			params.Password = clerk.String(password)
		}

		user, err := usersAPI.Create(params)
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(user, func() {
			output.Success(fmt.Sprintf("Created user %s", user.ID))
		})
	},
}

var usersUpdateCmd = &cobra.Command{
	Use:   "update <user-id>",
	Short: "Update user",
	Args:  RequireArg("user-id"),
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		usersAPI := api.NewUsersAPI(client)

		firstName, _ := cmd.Flags().GetString("first-name")
		lastName, _ := cmd.Flags().GetString("last-name")
		username, _ := cmd.Flags().GetString("username")

		params := sdkuser.UpdateParams{}
		if firstName != "" {
			params.FirstName = clerk.String(firstName)
		}
		if lastName != "" {
			params.LastName = clerk.String(lastName)
		}
		if username != "" {
			params.Username = clerk.String(username)
		}

		user, err := usersAPI.Update(args[0], params)
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(user, func() {
			output.Success(fmt.Sprintf("Updated user %s", user.ID))
		})
	},
}

var usersDeleteCmd = &cobra.Command{
	Use:   "delete <user-id>",
	Short: "Delete user",
	Args:  RequireArg("user-id"),
	RunE: func(cmd *cobra.Command, args []string) error {
		force, _ := cmd.Flags().GetBool("force")
		if !force && output.IsInteractive() {
			var confirm bool
			err := huh.NewConfirm().
				Title(fmt.Sprintf("Delete user %s?", args[0])).
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

		client := api.NewClient(api.ClientOptions{Profile: GetProfile(), Debug: IsDebug()})
		usersAPI := api.NewUsersAPI(client)

		if err := usersAPI.Delete(args[0]); err != nil {
			return err
		}

		output.Success(fmt.Sprintf("Deleted user %s", args[0]))
		return nil
	},
}

var usersBanCmd = &cobra.Command{
	Use:   "ban <user-id>",
	Short: "Ban user",
	Args:  RequireArg("user-id"),
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		usersAPI := api.NewUsersAPI(client)

		user, err := usersAPI.Ban(args[0])
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(user, func() {
			output.Success(fmt.Sprintf("Banned user %s", user.ID))
		})
	},
}

var usersUnbanCmd = &cobra.Command{
	Use:   "unban <user-id>",
	Short: "Unban user",
	Args:  RequireArg("user-id"),
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		usersAPI := api.NewUsersAPI(client)

		user, err := usersAPI.Unban(args[0])
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(user, func() {
			output.Success(fmt.Sprintf("Unbanned user %s", user.ID))
		})
	},
}

var usersLockCmd = &cobra.Command{
	Use:   "lock <user-id>",
	Short: "Lock user",
	Args:  RequireArg("user-id"),
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		usersAPI := api.NewUsersAPI(client)

		user, err := usersAPI.Lock(args[0])
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(user, func() {
			output.Success(fmt.Sprintf("Locked user %s", user.ID))
		})
	},
}

var usersUnlockCmd = &cobra.Command{
	Use:   "unlock <user-id>",
	Short: "Unlock user",
	Args:  RequireArg("user-id"),
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		usersAPI := api.NewUsersAPI(client)

		user, err := usersAPI.Unlock(args[0])
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(user, func() {
			output.Success(fmt.Sprintf("Unlocked user %s", user.ID))
		})
	},
}

var usersVerifyPasswordCmd = &cobra.Command{
	Use:   "verify-password <user-id>",
	Short: "Verify user password",
	Args:  RequireArg("user-id"),
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		usersAPI := api.NewUsersAPI(client)

		password, _ := cmd.Flags().GetString("password")
		if password == "" {
			return fmt.Errorf("--password is required")
		}

		verified, err := usersAPI.VerifyPassword(args[0], password)
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(map[string]bool{"verified": verified}, func() {
			if verified {
				output.Success("Password is correct")
			} else {
				output.Error("Password is incorrect")
			}
		})
	},
}

func init() {
	usersListCmd.Flags().Int("limit", 10, "Number of results to return")
	usersListCmd.Flags().Int("offset", 0, "Offset for pagination")
	usersListCmd.Flags().String("query", "", "Search query")
	usersListCmd.Flags().String("order-by", "", "Sort field (prefix with - for desc, + for asc)")
	usersListCmd.Flags().StringSlice("email", nil, "Filter by email addresses")
	usersListCmd.Flags().StringSlice("phone", nil, "Filter by phone numbers")
	usersListCmd.Flags().StringSlice("username", nil, "Filter by usernames")
	usersListCmd.Flags().StringSlice("external-id", nil, "Filter by external IDs")
	usersListCmd.Flags().StringSlice("user-id", nil, "Filter by user IDs")
	usersListCmd.Flags().StringSlice("organization-id", nil, "Filter by organization membership")
	usersListCmd.Flags().Int64("last-active-since", 0, "Filter users active since this Unix timestamp")

	usersCountCmd.Flags().String("query", "", "Search query")

	usersCreateCmd.Flags().String("email", "", "Email address")
	usersCreateCmd.Flags().String("first-name", "", "First name")
	usersCreateCmd.Flags().String("last-name", "", "Last name")
	usersCreateCmd.Flags().String("username", "", "Username")
	usersCreateCmd.Flags().String("password", "", "Password")

	usersUpdateCmd.Flags().String("first-name", "", "First name")
	usersUpdateCmd.Flags().String("last-name", "", "Last name")
	usersUpdateCmd.Flags().String("username", "", "Username")

	usersVerifyPasswordCmd.Flags().String("password", "", "Password to verify")

	usersDeleteCmd.Flags().BoolP("force", "f", false, "Skip confirmation prompt")

	usersCmd.AddCommand(usersListCmd)
	usersCmd.AddCommand(usersCountCmd)
	usersCmd.AddCommand(usersGetCmd)
	usersCmd.AddCommand(usersCreateCmd)
	usersCmd.AddCommand(usersUpdateCmd)
	usersCmd.AddCommand(usersDeleteCmd)
	usersCmd.AddCommand(usersBanCmd)
	usersCmd.AddCommand(usersUnbanCmd)
	usersCmd.AddCommand(usersLockCmd)
	usersCmd.AddCommand(usersUnlockCmd)
	usersCmd.AddCommand(usersVerifyPasswordCmd)
	usersCmd.AddCommand(usersEmailsCmd)
	usersCmd.AddCommand(usersPhonesCmd)
}
