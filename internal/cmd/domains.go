package cmd

import (
	"fmt"

	clerk "github.com/clerk/clerk-sdk-go/v2"
	sdkdomain "github.com/clerk/clerk-sdk-go/v2/domain"
	"github.com/spf13/cobra"

	"clerk.com/cli/internal/api"
	"clerk.com/cli/internal/output"
)

var domainsCmd = &cobra.Command{
	Use:   "domains",
	Short: "Instance domains",
	Long:  "Manage domains in your Clerk instance.",
}

var domainsListCmd = &cobra.Command{
	Use:     "list",
	Aliases: []string{"ls"},
	Short:   "List domains",
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		domainsAPI := api.NewDomainsAPI(client)

		result, err := domainsAPI.List()
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(result, func() {
			if len(result.Domains) == 0 {
				fmt.Println("No domains found")
				return
			}

			rows := make([][]string, len(result.Domains))
			for i, d := range result.Domains {
				satellite := "No"
				if d.IsSatellite {
					satellite = "Yes"
				}
				rows[i] = []string{d.ID, d.Name, satellite}
			}
			output.Table([]string{"ID", "NAME", "SATELLITE"}, rows)
			fmt.Printf("\nTotal: %d\n", result.TotalCount)
		})
	},
}

var domainsGetCmd = &cobra.Command{
	Use:   "get <domain-id>",
	Short: "Get domain",
	Args:  RequireArg("domain-id"),
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		domainsAPI := api.NewDomainsAPI(client)

		domain, err := domainsAPI.Get(args[0])
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(domain, func() {
			fmt.Println(output.BoldYellow("Domain:"), domain.ID)
			fmt.Println(output.Dim("Name:"), domain.Name)
			fmt.Println(output.Dim("Satellite:"), domain.IsSatellite)
			if domain.FrontendAPIURL != "" {
				fmt.Println(output.Dim("Frontend API:"), domain.FrontendAPIURL)
			}
		})
	},
}

var domainsAddCmd = &cobra.Command{
	Use:   "add",
	Short: "Add satellite domain",
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		domainsAPI := api.NewDomainsAPI(client)

		name, _ := cmd.Flags().GetString("name")
		proxyURL, _ := cmd.Flags().GetString("proxy-url")

		if name == "" {
			return fmt.Errorf("--name is required")
		}

		params := sdkdomain.CreateParams{
			Name:        clerk.String(name),
			IsSatellite: clerk.Bool(true),
		}
		if proxyURL != "" {
			params.ProxyURL = clerk.String(proxyURL)
		}

		domain, err := domainsAPI.Add(params)
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(domain, func() {
			output.Success(fmt.Sprintf("Added domain %s", domain.Name))
		})
	},
}

var domainsUpdateCmd = &cobra.Command{
	Use:   "update <domain-id>",
	Short: "Update domain",
	Args:  RequireArg("domain-id"),
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		domainsAPI := api.NewDomainsAPI(client)

		name, _ := cmd.Flags().GetString("name")
		proxyURL, _ := cmd.Flags().GetString("proxy-url")

		params := sdkdomain.UpdateParams{}
		if name != "" {
			params.Name = clerk.String(name)
		}
		if proxyURL != "" {
			params.ProxyURL = clerk.String(proxyURL)
		}

		domain, err := domainsAPI.Update(args[0], params)
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(domain, func() {
			output.Success(fmt.Sprintf("Updated domain %s", domain.ID))
		})
	},
}

var domainsDeleteCmd = &cobra.Command{
	Use:   "delete <domain-id>",
	Short: "Delete domain",
	Args:  RequireArg("domain-id"),
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		domainsAPI := api.NewDomainsAPI(client)

		if err := domainsAPI.Delete(args[0]); err != nil {
			return err
		}

		output.Success(fmt.Sprintf("Deleted domain %s", args[0]))
		return nil
	},
}

func init() {
	domainsAddCmd.Flags().String("name", "", "Domain name")
	domainsAddCmd.Flags().String("proxy-url", "", "Proxy URL")

	domainsUpdateCmd.Flags().String("name", "", "Domain name")
	domainsUpdateCmd.Flags().String("proxy-url", "", "Proxy URL")

	domainsCmd.AddCommand(domainsListCmd)
	domainsCmd.AddCommand(domainsGetCmd)
	domainsCmd.AddCommand(domainsAddCmd)
	domainsCmd.AddCommand(domainsUpdateCmd)
	domainsCmd.AddCommand(domainsDeleteCmd)
}
