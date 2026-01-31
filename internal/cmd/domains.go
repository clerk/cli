package cmd

import (
	"fmt"
	"time"

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

		domains, total, err := domainsAPI.List()
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(map[string]interface{}{
			"data":        domains,
			"total_count": total,
		}, func() {
			if len(domains) == 0 {
				fmt.Println("No domains found")
				return
			}

			rows := make([][]string, len(domains))
			for i, d := range domains {
				satellite := "No"
				if d.IsSatellite {
					satellite = "Yes"
				}
				created := time.UnixMilli(d.CreatedAt).Format("2006-01-02")
				rows[i] = []string{d.ID, d.Name, satellite, created}
			}
			output.Table([]string{"ID", "NAME", "SATELLITE", "CREATED"}, rows)
			fmt.Printf("\nTotal: %d\n", total)
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
			if domain.FrontendAPI != "" {
				fmt.Println(output.Dim("Frontend API:"), domain.FrontendAPI)
			}
			fmt.Println(output.Dim("Created:"), time.UnixMilli(domain.CreatedAt).Format(time.RFC3339))
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

		domain, err := domainsAPI.Add(api.AddDomainParams{
			Name:        name,
			IsSatellite: true,
			ProxyURL:    proxyURL,
		})
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

		domain, err := domainsAPI.Update(args[0], api.UpdateDomainParams{
			Name:     name,
			ProxyURL: proxyURL,
		})
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
