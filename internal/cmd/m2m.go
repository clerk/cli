package cmd

import (
	"fmt"
	"strings"
	"time"

	clerk "github.com/clerk/clerk-sdk-go/v2"
	sdkm2mtoken "github.com/clerk/clerk-sdk-go/v2/m2m_token"
	sdkmachine "github.com/clerk/clerk-sdk-go/v2/machine"
	"github.com/spf13/cobra"

	"clerk.com/cli/internal/api"
	"clerk.com/cli/internal/output"
)

var m2mCmd = &cobra.Command{
	Use:   "m2m",
	Short: "Machine-to-machine authentication",
	Long:  "Manage machine-to-machine tokens and machines in your Clerk instance.",
}

// Tokens subcommands
var m2mTokensCmd = &cobra.Command{
	Use:   "tokens",
	Short: "Manage M2M tokens",
}

var m2mTokensListCmd = &cobra.Command{
	Use:     "list",
	Aliases: []string{"ls"},
	Short:   "List tokens",
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		m2mAPI := api.NewM2MAPI(client)

		machineID, _ := cmd.Flags().GetString("machine-id")
		limit, _ := cmd.Flags().GetInt("limit")
		offset, _ := cmd.Flags().GetInt("offset")

		params := sdkm2mtoken.ListParams{}
		if machineID != "" {
			params.Subject = clerk.String(machineID)
		}
		if limit > 0 {
			params.Limit = clerk.Int64(int64(limit))
		}
		if offset > 0 {
			params.Offset = clerk.Int64(int64(offset))
		}

		result, err := m2mAPI.ListTokens(params)
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(result, func() {
			if len(result.M2MTokens) == 0 {
				fmt.Println("No tokens found")
				return
			}

			rows := make([][]string, len(result.M2MTokens))
			for i, t := range result.M2MTokens {
				scopes := strings.Join(t.Scopes, ", ")
				rows[i] = []string{t.ID, t.Subject, scopes}
			}
			output.Table([]string{"ID", "SUBJECT", "SCOPES"}, rows)
		})
	},
}

var m2mTokensCreateCmd = &cobra.Command{
	Use:   "create",
	Short: "Create token",
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		m2mAPI := api.NewM2MAPI(client)

		machineID, _ := cmd.Flags().GetString("machine-id")
		_, _ = cmd.Flags().GetString("scopes")
		expiresIn, _ := cmd.Flags().GetInt("expires-in")

		if machineID == "" {
			return fmt.Errorf("--machine-id is required")
		}

		params := sdkm2mtoken.CreateParams{}
		if expiresIn > 0 {
			params.SecondsUntilExpiration = clerk.Int64(int64(expiresIn))
		}

		token, err := m2mAPI.CreateToken(params)
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(token, func() {
			output.Success("Created M2M token")
			if token.Token != "" {
				fmt.Println()
				fmt.Println(output.Yellow("Token (save this, it won't be shown again):"))
				fmt.Println(token.Token)
			}
		})
	},
}

var m2mTokensVerifyCmd = &cobra.Command{
	Use:   "verify",
	Short: "Verify token",
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		m2mAPI := api.NewM2MAPI(client)

		token, _ := cmd.Flags().GetString("token")
		if token == "" {
			return fmt.Errorf("--token is required")
		}

		result, err := m2mAPI.VerifyToken(sdkm2mtoken.VerifyParams{Token: token})
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(result, func() {
			output.Success("Token is valid")
			fmt.Println(output.Dim("Subject:"), result.Subject)
			fmt.Println(output.Dim("Scopes:"), strings.Join(result.Scopes, ", "))
		})
	},
}

// Machines subcommands
var m2mMachinesCmd = &cobra.Command{
	Use:   "machines",
	Short: "Manage machines",
}

var m2mMachinesListCmd = &cobra.Command{
	Use:     "list",
	Aliases: []string{"ls"},
	Short:   "List machines",
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		m2mAPI := api.NewM2MAPI(client)

		limit, _ := cmd.Flags().GetInt("limit")
		offset, _ := cmd.Flags().GetInt("offset")
		query, _ := cmd.Flags().GetString("query")

		params := sdkmachine.ListParams{}
		if limit > 0 {
			params.Limit = clerk.Int64(int64(limit))
		}
		if offset > 0 {
			params.Offset = clerk.Int64(int64(offset))
		}
		if query != "" {
			params.Query = clerk.String(query)
		}

		result, err := m2mAPI.ListMachines(params)
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(result, func() {
			if len(result.Machines) == 0 {
				fmt.Println("No machines found")
				return
			}

			rows := make([][]string, len(result.Machines))
			for i, m := range result.Machines {
				created := time.UnixMilli(m.CreatedAt).Format("2006-01-02")
				rows[i] = []string{m.ID, m.Name, created}
			}
			output.Table([]string{"ID", "NAME", "CREATED"}, rows)
			fmt.Printf("\nTotal: %d\n", result.TotalCount)
		})
	},
}

var m2mMachinesGetCmd = &cobra.Command{
	Use:   "get <machine-id>",
	Short: "Get machine",
	Args:  RequireArg("machine-id"),
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		m2mAPI := api.NewM2MAPI(client)

		machine, err := m2mAPI.GetMachine(args[0])
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(machine, func() {
			fmt.Println(output.BoldYellow("Machine:"), machine.ID)
			fmt.Println(output.Dim("Name:"), machine.Name)
			fmt.Println(output.Dim("Created:"), time.UnixMilli(machine.CreatedAt).Format(time.RFC3339))
		})
	},
}

var m2mMachinesCreateCmd = &cobra.Command{
	Use:   "create",
	Short: "Create machine",
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		m2mAPI := api.NewM2MAPI(client)

		name, _ := cmd.Flags().GetString("name")
		scopesStr, _ := cmd.Flags().GetString("scopes")

		if name == "" {
			return fmt.Errorf("--name is required")
		}

		var scopes []string
		if scopesStr != "" {
			scopes = strings.Split(scopesStr, ",")
		}

		machine, err := m2mAPI.CreateMachine(sdkmachine.CreateParams{
			Name:           name,
			ScopedMachines: scopes,
		})
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(machine, func() {
			output.Success(fmt.Sprintf("Created machine %s", machine.ID))
			if machine.SecretKey != "" {
				fmt.Println()
				fmt.Println(output.Yellow("Secret Key (save this, it won't be shown again):"))
				fmt.Println(machine.SecretKey)
			}
		})
	},
}

var m2mMachinesUpdateCmd = &cobra.Command{
	Use:   "update <machine-id>",
	Short: "Update machine",
	Args:  RequireArg("machine-id"),
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		m2mAPI := api.NewM2MAPI(client)

		name, _ := cmd.Flags().GetString("name")

		params := sdkmachine.UpdateParams{}
		if name != "" {
			params.Name = clerk.String(name)
		}

		machine, err := m2mAPI.UpdateMachine(args[0], params)
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(machine, func() {
			output.Success(fmt.Sprintf("Updated machine %s", machine.ID))
		})
	},
}

var m2mMachinesDeleteCmd = &cobra.Command{
	Use:   "delete <machine-id>",
	Short: "Delete machine",
	Args:  RequireArg("machine-id"),
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		m2mAPI := api.NewM2MAPI(client)

		if err := m2mAPI.DeleteMachine(args[0]); err != nil {
			return err
		}

		output.Success(fmt.Sprintf("Deleted machine %s", args[0]))
		return nil
	},
}

var m2mMachinesGetSecretCmd = &cobra.Command{
	Use:   "get-secret <machine-id>",
	Short: "Get machine secret",
	Args:  RequireArg("machine-id"),
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		m2mAPI := api.NewM2MAPI(client)

		secret, err := m2mAPI.GetMachineSecret(args[0])
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(secret, func() {
			fmt.Println(secret.Secret)
		})
	},
}

var m2mMachinesAddScopeCmd = &cobra.Command{
	Use:   "add-scope <machine-id>",
	Short: "Add scope to machine",
	Args:  RequireArg("machine-id"),
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		m2mAPI := api.NewM2MAPI(client)

		scope, _ := cmd.Flags().GetString("scope")
		if scope == "" {
			return fmt.Errorf("--scope is required")
		}

		if err := m2mAPI.AddScope(args[0], scope); err != nil {
			return err
		}

		output.Success(fmt.Sprintf("Added scope to machine %s", args[0]))
		return nil
	},
}

func init() {
	m2mTokensListCmd.Flags().String("machine-id", "", "Filter by machine ID")
	m2mTokensListCmd.Flags().Int("limit", 10, "Number of results to return")
	m2mTokensListCmd.Flags().Int("offset", 0, "Offset for pagination")

	m2mTokensCreateCmd.Flags().String("machine-id", "", "Machine ID")
	m2mTokensCreateCmd.Flags().String("scopes", "", "Comma-separated scopes")
	m2mTokensCreateCmd.Flags().Int("expires-in", 0, "Token expiration in seconds")

	m2mTokensVerifyCmd.Flags().String("token", "", "Token to verify")

	m2mMachinesListCmd.Flags().Int("limit", 10, "Number of results to return")
	m2mMachinesListCmd.Flags().Int("offset", 0, "Offset for pagination")
	m2mMachinesListCmd.Flags().String("query", "", "Search query")

	m2mMachinesCreateCmd.Flags().String("name", "", "Machine name")
	m2mMachinesCreateCmd.Flags().String("scopes", "", "Comma-separated scopes")

	m2mMachinesUpdateCmd.Flags().String("name", "", "Machine name")

	m2mMachinesAddScopeCmd.Flags().String("scope", "", "Scope to add")

	m2mTokensCmd.AddCommand(m2mTokensListCmd)
	m2mTokensCmd.AddCommand(m2mTokensCreateCmd)
	m2mTokensCmd.AddCommand(m2mTokensVerifyCmd)

	m2mMachinesCmd.AddCommand(m2mMachinesListCmd)
	m2mMachinesCmd.AddCommand(m2mMachinesGetCmd)
	m2mMachinesCmd.AddCommand(m2mMachinesCreateCmd)
	m2mMachinesCmd.AddCommand(m2mMachinesUpdateCmd)
	m2mMachinesCmd.AddCommand(m2mMachinesDeleteCmd)
	m2mMachinesCmd.AddCommand(m2mMachinesGetSecretCmd)
	m2mMachinesCmd.AddCommand(m2mMachinesAddScopeCmd)

	m2mCmd.AddCommand(m2mTokensCmd)
	m2mCmd.AddCommand(m2mMachinesCmd)
}
