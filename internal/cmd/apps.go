package cmd

import (
	"fmt"
	"time"

	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"

	"clerk.com/cli/internal/api"
	"clerk.com/cli/internal/output"
)

var appsCmd = &cobra.Command{
	Use:     "apps",
	Aliases: []string{"applications"},
	Short:   "Manage applications",
	Long:    "Manage applications in your Clerk workspace using the Platform API.",
}

var appsListCmd = &cobra.Command{
	Use:     "list",
	Aliases: []string{"ls"},
	Short:   "List applications",
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetPlatformClient()
		if err != nil {
			return err
		}
		appsAPI := api.NewApplicationsAPI(client)

		limit, _ := cmd.Flags().GetInt("limit")
		offset, _ := cmd.Flags().GetInt("offset")
		query, _ := cmd.Flags().GetString("query")

		apps, total, err := appsAPI.List(api.ListApplicationsParams{
			Limit:  limit,
			Offset: offset,
			Query:  query,
		})
		if err != nil {
			return err
		}

		formatter := GetFormatter()

		return formatter.Output(map[string]any{
			"data":        apps,
			"total_count": total,
		}, func() {
			if len(apps) == 0 {
				fmt.Println("No applications found")
				return
			}

			var rows [][]string
			for _, a := range apps {
				for i, inst := range a.Instances {
					appID := a.ID
					if i > 0 {
						appID = "" // Only show app ID on first row of group
					}
					rows = append(rows, []string{appID, inst.ID, inst.EnvironmentType})
				}
			}
			output.Table([]string{"APPLICATION", "INSTANCE", "TYPE"}, rows)
			fmt.Printf("\nTotal: %d applications\n", total)
		})
	},
}

var appsGetCmd = &cobra.Command{
	Use:   "get <app-id>",
	Short: "Get application details",
	Args:  RequireArg("app-id"),
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetPlatformClient()
		if err != nil {
			return err
		}
		appsAPI := api.NewApplicationsAPI(client)

		app, err := appsAPI.Get(args[0])
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(app, func() {
			fmt.Println(output.BoldYellow("Application:"), app.ID)
			if app.Name != "" {
				fmt.Println(output.Dim("Name:"), app.Name)
			}
			if app.LogoURL != "" {
				fmt.Println(output.Dim("Logo URL:"), app.LogoURL)
			}
			if app.HomeURL != "" {
				fmt.Println(output.Dim("Home URL:"), app.HomeURL)
			}
			if len(app.Instances) > 0 {
				fmt.Println(output.Dim("Instances:"))
				for _, inst := range app.Instances {
					fmt.Printf("  - %s (%s)\n", inst.ID, inst.EnvironmentType)
				}
			}
			if app.CreatedAt > 0 {
				fmt.Println(output.Dim("Created:"), time.UnixMilli(app.CreatedAt).Format(time.RFC3339))
			}
			if app.UpdatedAt > 0 {
				fmt.Println(output.Dim("Updated:"), time.UnixMilli(app.UpdatedAt).Format(time.RFC3339))
			}
		})
	},
}

var appsCreateCmd = &cobra.Command{
	Use:   "create",
	Short: "Create an application",
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetPlatformClient()
		if err != nil {
			return err
		}
		appsAPI := api.NewApplicationsAPI(client)

		name, _ := cmd.Flags().GetString("name")
		logoURL, _ := cmd.Flags().GetString("logo-url")
		homeURL, _ := cmd.Flags().GetString("home-url")

		if name == "" {
			return fmt.Errorf("--name is required")
		}

		app, err := appsAPI.Create(api.CreateApplicationParams{
			Name:    name,
			LogoURL: logoURL,
			HomeURL: homeURL,
		})
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(app, func() {
			output.Success(fmt.Sprintf("Created application %s", app.ID))
		})
	},
}

var appsUpdateCmd = &cobra.Command{
	Use:   "update <app-id>",
	Short: "Update an application",
	Args:  RequireArg("app-id"),
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetPlatformClient()
		if err != nil {
			return err
		}
		appsAPI := api.NewApplicationsAPI(client)

		name, _ := cmd.Flags().GetString("name")
		logoURL, _ := cmd.Flags().GetString("logo-url")
		homeURL, _ := cmd.Flags().GetString("home-url")

		app, err := appsAPI.Update(args[0], api.UpdateApplicationParams{
			Name:    name,
			LogoURL: logoURL,
			HomeURL: homeURL,
		})
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(app, func() {
			output.Success(fmt.Sprintf("Updated application %s", app.ID))
		})
	},
}

var appsDeleteCmd = &cobra.Command{
	Use:   "delete <app-id>",
	Short: "Delete an application",
	Args:  RequireArg("app-id"),
	RunE: func(cmd *cobra.Command, args []string) error {
		force, _ := cmd.Flags().GetBool("force")
		if !force && output.IsInteractive() {
			var confirm bool
			err := huh.NewConfirm().
				Title(fmt.Sprintf("Delete application %s?", args[0])).
				Description("This action cannot be undone.").
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

		client, err := GetPlatformClient()
		if err != nil {
			return err
		}
		appsAPI := api.NewApplicationsAPI(client)

		if err := appsAPI.Delete(args[0]); err != nil {
			return err
		}

		output.Success(fmt.Sprintf("Deleted application %s", args[0]))
		return nil
	},
}

var appsInstancesCmd = &cobra.Command{
	Use:   "instances",
	Short: "Manage application instances",
}

var appsInstancesListCmd = &cobra.Command{
	Use:     "list <app-id>",
	Aliases: []string{"ls"},
	Short:   "List instances for an application",
	Args:    RequireArg("app-id"),
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetPlatformClient()
		if err != nil {
			return err
		}
		appsAPI := api.NewApplicationsAPI(client)

		includeSecretKeys, _ := cmd.Flags().GetBool("include-secret-keys")

		instances, total, err := appsAPI.ListInstances(args[0], api.ListInstancesParams{
			IncludeSecretKeys: includeSecretKeys,
		})
		if err != nil {
			return err
		}

		formatter := GetFormatter()

		return formatter.Output(map[string]any{
			"data":        instances,
			"total_count": total,
		}, func() {
			if len(instances) == 0 {
				fmt.Println("No instances found")
				return
			}

			rows := make([][]string, len(instances))
			for i, inst := range instances {
				if includeSecretKeys {
					rows[i] = []string{inst.ID, inst.EnvironmentType, inst.SecretKey}
				} else {
					rows[i] = []string{inst.ID, inst.EnvironmentType, inst.PublishableKey}
				}
			}
			if includeSecretKeys {
				output.Table([]string{"INSTANCE", "TYPE", "SECRET KEY"}, rows)
			} else {
				output.Table([]string{"INSTANCE", "TYPE", "PUBLISHABLE KEY"}, rows)
			}
			fmt.Printf("\nTotal: %d\n", total)
		})
	},
}

func init() {
	appsListCmd.Flags().Int("limit", 10, "Number of results to return")
	appsListCmd.Flags().Int("offset", 0, "Offset for pagination")
	appsListCmd.Flags().String("query", "", "Search query")

	appsCreateCmd.Flags().String("name", "", "Application name (required)")
	appsCreateCmd.Flags().String("logo-url", "", "Logo URL")
	appsCreateCmd.Flags().String("home-url", "", "Home URL")

	appsUpdateCmd.Flags().String("name", "", "Application name")
	appsUpdateCmd.Flags().String("logo-url", "", "Logo URL")
	appsUpdateCmd.Flags().String("home-url", "", "Home URL")

	appsDeleteCmd.Flags().BoolP("force", "f", false, "Skip confirmation prompt")

	appsInstancesListCmd.Flags().Bool("include-secret-keys", false, "Include secret keys in output")

	appsInstancesCmd.AddCommand(appsInstancesListCmd)

	appsCmd.AddCommand(appsListCmd)
	appsCmd.AddCommand(appsGetCmd)
	appsCmd.AddCommand(appsCreateCmd)
	appsCmd.AddCommand(appsUpdateCmd)
	appsCmd.AddCommand(appsDeleteCmd)
	appsCmd.AddCommand(appsInstancesCmd)
}
