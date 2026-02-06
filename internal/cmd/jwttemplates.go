package cmd

import (
	"encoding/json"
	"fmt"
	"time"

	clerk "github.com/clerk/clerk-sdk-go/v2"
	sdkjwt "github.com/clerk/clerk-sdk-go/v2/jwttemplate"
	"github.com/spf13/cobra"

	"clerk.com/cli/internal/api"
	"clerk.com/cli/internal/output"
)

var jwtTemplatesCmd = &cobra.Command{
	Use:   "jwt-templates",
	Short: "JWT token templates",
	Long:  "Manage JWT templates in your Clerk instance.",
}

var jwtTemplatesListCmd = &cobra.Command{
	Use:     "list",
	Aliases: []string{"ls"},
	Short:   "List JWT templates",
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		jwtAPI := api.NewJWTTemplatesAPI(client)

		result, err := jwtAPI.List()
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(result, func() {
			if len(result.JWTTemplates) == 0 {
				fmt.Println("No JWT templates found")
				return
			}

			rows := make([][]string, len(result.JWTTemplates))
			for i, t := range result.JWTTemplates {
				created := time.UnixMilli(t.CreatedAt).Format("2006-01-02")
				rows[i] = []string{t.ID, t.Name, t.SigningAlgorithm, created}
			}
			output.Table([]string{"ID", "NAME", "ALGORITHM", "CREATED"}, rows)
			fmt.Printf("\nTotal: %d\n", result.TotalCount)
		})
	},
}

var jwtTemplatesGetCmd = &cobra.Command{
	Use:   "get <template-id>",
	Short: "Get JWT template",
	Args:  RequireArg("template-id"),
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		jwtAPI := api.NewJWTTemplatesAPI(client)

		template, err := jwtAPI.Get(args[0])
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(template, func() {
			fmt.Println(output.BoldYellow("JWT Template:"), template.ID)
			fmt.Println(output.Dim("Name:"), template.Name)
			fmt.Println(output.Dim("Algorithm:"), template.SigningAlgorithm)
			fmt.Println(output.Dim("Lifetime:"), template.Lifetime, "seconds")
			fmt.Println(output.Dim("Clock Skew:"), template.AllowedClockSkew, "seconds")
			if len(template.Claims) > 0 {
				var claimsParsed interface{}
				if err := json.Unmarshal(template.Claims, &claimsParsed); err == nil {
					if claimsJSON, err := json.MarshalIndent(claimsParsed, "", "  "); err == nil {
						fmt.Println(output.Dim("Claims:"))
						fmt.Println(string(claimsJSON))
					}
				}
			}
		})
	},
}

var jwtTemplatesCreateCmd = &cobra.Command{
	Use:   "create",
	Short: "Create JWT template",
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		jwtAPI := api.NewJWTTemplatesAPI(client)

		name, _ := cmd.Flags().GetString("name")
		claimsStr, _ := cmd.Flags().GetString("claims")
		lifetime, _ := cmd.Flags().GetInt("lifetime")
		clockSkew, _ := cmd.Flags().GetInt("clock-skew")
		algorithm, _ := cmd.Flags().GetString("algorithm")

		if name == "" {
			return fmt.Errorf("--name is required")
		}

		var claimsJSON json.RawMessage
		if claimsStr != "" {
			var parsed interface{}
			if err := json.Unmarshal([]byte(claimsStr), &parsed); err != nil {
				return fmt.Errorf("invalid claims JSON: %w", err)
			}
			claimsJSON = json.RawMessage(claimsStr)
		}

		params := sdkjwt.CreateParams{
			Name: clerk.String(name),
		}
		if len(claimsJSON) > 0 {
			params.Claims = claimsJSON
		}
		if lifetime > 0 {
			params.Lifetime = clerk.Int64(int64(lifetime))
		}
		if clockSkew > 0 {
			params.AllowedClockSkew = clerk.Int64(int64(clockSkew))
		}
		if algorithm != "" {
			params.SigningAlgorithm = clerk.String(algorithm)
		}

		template, err := jwtAPI.Create(params)
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(template, func() {
			output.Success(fmt.Sprintf("Created JWT template %s", template.ID))
		})
	},
}

var jwtTemplatesUpdateCmd = &cobra.Command{
	Use:   "update <template-id>",
	Short: "Update JWT template",
	Args:  RequireArg("template-id"),
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		jwtAPI := api.NewJWTTemplatesAPI(client)

		name, _ := cmd.Flags().GetString("name")
		claimsStr, _ := cmd.Flags().GetString("claims")
		lifetime, _ := cmd.Flags().GetInt("lifetime")
		clockSkew, _ := cmd.Flags().GetInt("clock-skew")

		var claimsJSON json.RawMessage
		if claimsStr != "" {
			var parsed interface{}
			if err := json.Unmarshal([]byte(claimsStr), &parsed); err != nil {
				return fmt.Errorf("invalid claims JSON: %w", err)
			}
			claimsJSON = json.RawMessage(claimsStr)
		}

		params := sdkjwt.UpdateParams{}
		if name != "" {
			params.Name = clerk.String(name)
		}
		if len(claimsJSON) > 0 {
			params.Claims = claimsJSON
		}
		if lifetime > 0 {
			params.Lifetime = clerk.Int64(int64(lifetime))
		}
		if clockSkew > 0 {
			params.AllowedClockSkew = clerk.Int64(int64(clockSkew))
		}

		template, err := jwtAPI.Update(args[0], params)
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(template, func() {
			output.Success(fmt.Sprintf("Updated JWT template %s", template.ID))
		})
	},
}

var jwtTemplatesDeleteCmd = &cobra.Command{
	Use:   "delete <template-id>",
	Short: "Delete JWT template",
	Args:  RequireArg("template-id"),
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		jwtAPI := api.NewJWTTemplatesAPI(client)

		if err := jwtAPI.Delete(args[0]); err != nil {
			return err
		}

		output.Success(fmt.Sprintf("Deleted JWT template %s", args[0]))
		return nil
	},
}

func init() {
	jwtTemplatesCreateCmd.Flags().String("name", "", "Template name")
	jwtTemplatesCreateCmd.Flags().String("claims", "", "Claims JSON")
	jwtTemplatesCreateCmd.Flags().Int("lifetime", 60, "Token lifetime in seconds")
	jwtTemplatesCreateCmd.Flags().Int("clock-skew", 5, "Allowed clock skew in seconds")
	jwtTemplatesCreateCmd.Flags().String("algorithm", "RS256", "Signing algorithm")

	jwtTemplatesUpdateCmd.Flags().String("name", "", "Template name")
	jwtTemplatesUpdateCmd.Flags().String("claims", "", "Claims JSON")
	jwtTemplatesUpdateCmd.Flags().Int("lifetime", 0, "Token lifetime in seconds")
	jwtTemplatesUpdateCmd.Flags().Int("clock-skew", 0, "Allowed clock skew in seconds")

	jwtTemplatesCmd.AddCommand(jwtTemplatesListCmd)
	jwtTemplatesCmd.AddCommand(jwtTemplatesGetCmd)
	jwtTemplatesCmd.AddCommand(jwtTemplatesCreateCmd)
	jwtTemplatesCmd.AddCommand(jwtTemplatesUpdateCmd)
	jwtTemplatesCmd.AddCommand(jwtTemplatesDeleteCmd)
}
