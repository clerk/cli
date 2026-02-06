package cmd

import (
	"fmt"
	"time"

	"github.com/charmbracelet/huh"
	clerk "github.com/clerk/clerk-sdk-go/v2"
	sdkorg "github.com/clerk/clerk-sdk-go/v2/organization"
	sdkorginvitation "github.com/clerk/clerk-sdk-go/v2/organizationinvitation"
	sdkmembership "github.com/clerk/clerk-sdk-go/v2/organizationmembership"
	"github.com/spf13/cobra"

	"clerk.com/cli/internal/api"
	"clerk.com/cli/internal/output"
)

var organizationsCmd = &cobra.Command{
	Use:     "organizations",
	Aliases: []string{"orgs"},
	Short:   "Organizations and members",
	Long:    "Manage organizations in your Clerk instance.",
}

var orgsListCmd = &cobra.Command{
	Use:     "list",
	Aliases: []string{"ls"},
	Short:   "List organizations",
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		orgsAPI := api.NewOrganizationsAPI(client)

		limit, _ := cmd.Flags().GetInt("limit")
		offset, _ := cmd.Flags().GetInt("offset")
		query, _ := cmd.Flags().GetString("query")

		params := sdkorg.ListParams{}
		if limit > 0 {
			params.Limit = clerk.Int64(int64(limit))
		}
		if offset > 0 {
			params.Offset = clerk.Int64(int64(offset))
		}
		if query != "" {
			params.Query = clerk.String(query)
		}

		result, err := orgsAPI.List(params)
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(result, func() {
			if len(result.Organizations) == 0 {
				fmt.Println("No organizations found")
				return
			}

			rows := make([][]string, len(result.Organizations))
			for i, o := range result.Organizations {
				created := time.UnixMilli(o.CreatedAt).Format("2006-01-02")
				rows[i] = []string{o.ID, o.Name, o.Slug, created}
			}
			output.Table([]string{"ID", "NAME", "SLUG", "CREATED"}, rows)
			fmt.Printf("\nTotal: %d\n", result.TotalCount)
		})
	},
}

var orgsGetCmd = &cobra.Command{
	Use:   "get <organization-id>",
	Short: "Get organization",
	Args:  RequireArg("organization-id"),
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		orgsAPI := api.NewOrganizationsAPI(client)

		org, err := orgsAPI.Get(args[0])
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(org, func() {
			fmt.Println(output.BoldYellow("Organization:"), org.ID)
			fmt.Println(output.Dim("Name:"), org.Name)
			fmt.Println(output.Dim("Slug:"), org.Slug)
			fmt.Println(output.Dim("Created:"), time.UnixMilli(org.CreatedAt).Format(time.RFC3339))
		})
	},
}

var orgsCreateCmd = &cobra.Command{
	Use:   "create",
	Short: "Create organization",
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		orgsAPI := api.NewOrganizationsAPI(client)

		name, _ := cmd.Flags().GetString("name")
		slug, _ := cmd.Flags().GetString("slug")
		createdBy, _ := cmd.Flags().GetString("created-by")

		if name == "" {
			return fmt.Errorf("--name is required")
		}

		params := sdkorg.CreateParams{
			Name: clerk.String(name),
		}
		if slug != "" {
			params.Slug = clerk.String(slug)
		}
		if createdBy != "" {
			params.CreatedBy = clerk.String(createdBy)
		}

		org, err := orgsAPI.Create(params)
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(org, func() {
			output.Success(fmt.Sprintf("Created organization %s", org.ID))
		})
	},
}

var orgsUpdateCmd = &cobra.Command{
	Use:   "update <organization-id>",
	Short: "Update organization",
	Args:  RequireArg("organization-id"),
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		orgsAPI := api.NewOrganizationsAPI(client)

		name, _ := cmd.Flags().GetString("name")
		slug, _ := cmd.Flags().GetString("slug")

		params := sdkorg.UpdateParams{}
		if name != "" {
			params.Name = clerk.String(name)
		}
		if slug != "" {
			params.Slug = clerk.String(slug)
		}

		org, err := orgsAPI.Update(args[0], params)
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(org, func() {
			output.Success(fmt.Sprintf("Updated organization %s", org.ID))
		})
	},
}

var orgsDeleteCmd = &cobra.Command{
	Use:   "delete <organization-id>",
	Short: "Delete organization",
	Args:  RequireArg("organization-id"),
	RunE: func(cmd *cobra.Command, args []string) error {
		force, _ := cmd.Flags().GetBool("force")
		if !force && output.IsInteractive() {
			var confirm bool
			err := huh.NewConfirm().
				Title(fmt.Sprintf("Delete organization %s?", args[0])).
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
		orgsAPI := api.NewOrganizationsAPI(client)

		if err := orgsAPI.Delete(args[0]); err != nil {
			return err
		}

		output.Success(fmt.Sprintf("Deleted organization %s", args[0]))
		return nil
	},
}

// Members subcommands
var orgsMembersCmd = &cobra.Command{
	Use:   "members",
	Short: "Manage organization members",
}

var orgsMembersListCmd = &cobra.Command{
	Use:     "list <organization-id>",
	Aliases: []string{"ls"},
	Short:   "List members",
	Args:    RequireArg("organization-id"),
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		orgsAPI := api.NewOrganizationsAPI(client)

		limit, _ := cmd.Flags().GetInt("limit")
		offset, _ := cmd.Flags().GetInt("offset")

		params := sdkmembership.ListParams{
			OrganizationID: args[0],
		}
		if limit > 0 {
			params.Limit = clerk.Int64(int64(limit))
		}
		if offset > 0 {
			params.Offset = clerk.Int64(int64(offset))
		}

		result, err := orgsAPI.ListMembers(params)
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(result, func() {
			if len(result.OrganizationMemberships) == 0 {
				fmt.Println("No members found")
				return
			}

			rows := make([][]string, len(result.OrganizationMemberships))
			for i, m := range result.OrganizationMemberships {
				rows[i] = []string{m.ID, m.Role, time.UnixMilli(m.CreatedAt).Format("2006-01-02")}
			}
			output.Table([]string{"ID", "ROLE", "JOINED"}, rows)
			fmt.Printf("\nTotal: %d\n", result.TotalCount)
		})
	},
}

var orgsMembersAddCmd = &cobra.Command{
	Use:   "add <organization-id>",
	Short: "Add member",
	Args:  RequireArg("organization-id"),
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		orgsAPI := api.NewOrganizationsAPI(client)

		userID, _ := cmd.Flags().GetString("user-id")
		role, _ := cmd.Flags().GetString("role")

		if userID == "" {
			return fmt.Errorf("--user-id is required")
		}

		member, err := orgsAPI.AddMember(sdkmembership.CreateParams{
			OrganizationID: args[0],
			UserID:         clerk.String(userID),
			Role:           clerk.String(role),
		})
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(member, func() {
			output.Success(fmt.Sprintf("Added member %s", member.ID))
		})
	},
}

var orgsMembersUpdateCmd = &cobra.Command{
	Use:   "update <organization-id> <user-id>",
	Short: "Update member",
	Args:  RequireArgs("organization-id", "user-id"),
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		orgsAPI := api.NewOrganizationsAPI(client)

		role, _ := cmd.Flags().GetString("role")

		member, err := orgsAPI.UpdateMember(sdkmembership.UpdateParams{
			OrganizationID: args[0],
			UserID:         args[1],
			Role:           clerk.String(role),
		})
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(member, func() {
			output.Success(fmt.Sprintf("Updated member %s", member.ID))
		})
	},
}

var orgsMembersRemoveCmd = &cobra.Command{
	Use:   "remove <organization-id> <user-id>",
	Short: "Remove member",
	Args:  RequireArgs("organization-id", "user-id"),
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		orgsAPI := api.NewOrganizationsAPI(client)

		if err := orgsAPI.RemoveMember(sdkmembership.DeleteParams{
			OrganizationID: args[0],
			UserID:         args[1],
		}); err != nil {
			return err
		}

		output.Success("Removed member")
		return nil
	},
}

// Invitations subcommands
var orgsInvitationsCmd = &cobra.Command{
	Use:     "invitations",
	Aliases: []string{"invites"},
	Short:   "Manage organization invitations",
}

var orgsInvitationsListCmd = &cobra.Command{
	Use:     "list <organization-id>",
	Aliases: []string{"ls"},
	Short:   "List invitations",
	Args:    RequireArg("organization-id"),
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		orgsAPI := api.NewOrganizationsAPI(client)

		limit, _ := cmd.Flags().GetInt("limit")
		offset, _ := cmd.Flags().GetInt("offset")

		params := sdkorginvitation.ListParams{
			OrganizationID: args[0],
		}
		if limit > 0 {
			params.Limit = clerk.Int64(int64(limit))
		}
		if offset > 0 {
			params.Offset = clerk.Int64(int64(offset))
		}

		result, err := orgsAPI.ListInvitations(params)
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(result, func() {
			if len(result.OrganizationInvitations) == 0 {
				fmt.Println("No invitations found")
				return
			}

			rows := make([][]string, len(result.OrganizationInvitations))
			for i, inv := range result.OrganizationInvitations {
				rows[i] = []string{inv.ID, inv.EmailAddress, inv.Role, inv.Status}
			}
			output.Table([]string{"ID", "EMAIL", "ROLE", "STATUS"}, rows)
		})
	},
}

var orgsInvitationsCreateCmd = &cobra.Command{
	Use:   "create <organization-id>",
	Short: "Create invitation",
	Args:  RequireArg("organization-id"),
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		orgsAPI := api.NewOrganizationsAPI(client)

		email, _ := cmd.Flags().GetString("email")
		role, _ := cmd.Flags().GetString("role")

		if email == "" {
			return fmt.Errorf("--email is required")
		}

		invitation, err := orgsAPI.CreateInvitation(sdkorginvitation.CreateParams{
			OrganizationID: args[0],
			EmailAddress:   clerk.String(email),
			Role:           clerk.String(role),
		})
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(invitation, func() {
			output.Success(fmt.Sprintf("Created invitation %s", invitation.ID))
		})
	},
}

var orgsInvitationsRevokeCmd = &cobra.Command{
	Use:   "revoke <organization-id> <invitation-id>",
	Short: "Revoke invitation",
	Args:  RequireArgs("organization-id", "invitation-id"),
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		orgsAPI := api.NewOrganizationsAPI(client)

		invitation, err := orgsAPI.RevokeInvitation(sdkorginvitation.RevokeParams{
			OrganizationID: args[0],
			ID:             args[1],
		})
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
	orgsListCmd.Flags().Int("limit", 10, "Number of results to return")
	orgsListCmd.Flags().Int("offset", 0, "Offset for pagination")
	orgsListCmd.Flags().String("query", "", "Search query")

	orgsCreateCmd.Flags().String("name", "", "Organization name")
	orgsCreateCmd.Flags().String("slug", "", "Organization slug")
	orgsCreateCmd.Flags().String("created-by", "", "User ID of creator")

	orgsUpdateCmd.Flags().String("name", "", "Organization name")
	orgsUpdateCmd.Flags().String("slug", "", "Organization slug")

	orgsDeleteCmd.Flags().BoolP("force", "f", false, "Skip confirmation prompt")

	orgsMembersListCmd.Flags().Int("limit", 10, "Number of results to return")
	orgsMembersListCmd.Flags().Int("offset", 0, "Offset for pagination")

	orgsMembersAddCmd.Flags().String("user-id", "", "User ID to add")
	orgsMembersAddCmd.Flags().String("role", "basic_member", "Role")

	orgsMembersUpdateCmd.Flags().String("role", "", "New role")

	orgsInvitationsListCmd.Flags().Int("limit", 10, "Number of results to return")
	orgsInvitationsListCmd.Flags().Int("offset", 0, "Offset for pagination")

	orgsInvitationsCreateCmd.Flags().String("email", "", "Email address")
	orgsInvitationsCreateCmd.Flags().String("role", "basic_member", "Role")

	orgsMembersCmd.AddCommand(orgsMembersListCmd)
	orgsMembersCmd.AddCommand(orgsMembersAddCmd)
	orgsMembersCmd.AddCommand(orgsMembersUpdateCmd)
	orgsMembersCmd.AddCommand(orgsMembersRemoveCmd)

	orgsInvitationsCmd.AddCommand(orgsInvitationsListCmd)
	orgsInvitationsCmd.AddCommand(orgsInvitationsCreateCmd)
	orgsInvitationsCmd.AddCommand(orgsInvitationsRevokeCmd)

	organizationsCmd.AddCommand(orgsListCmd)
	organizationsCmd.AddCommand(orgsGetCmd)
	organizationsCmd.AddCommand(orgsCreateCmd)
	organizationsCmd.AddCommand(orgsUpdateCmd)
	organizationsCmd.AddCommand(orgsDeleteCmd)
	organizationsCmd.AddCommand(orgsMembersCmd)
	organizationsCmd.AddCommand(orgsInvitationsCmd)
}
