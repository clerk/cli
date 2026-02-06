package cmd

import (
	"fmt"

	"github.com/spf13/cobra"

	"clerk.com/cli/internal/api"
	"clerk.com/cli/internal/output"
)

var jwksCmd = &cobra.Command{
	Use:   "jwks",
	Short: "JSON Web Key Sets",
	Long:  "Manage JSON Web Key Sets for your Clerk instance.",
}

var jwksGetCmd = &cobra.Command{
	Use:   "get",
	Short: "Get JWKS",
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		jwksAPI := api.NewJWKSAPI(client)

		jwks, err := jwksAPI.Get()
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(jwks, func() {
			if len(jwks.Keys) == 0 {
				fmt.Println("No keys found")
				return
			}

			rows := make([][]string, len(jwks.Keys))
			for i, k := range jwks.Keys {
				rows[i] = []string{k.KeyID, k.Algorithm, k.Use}
			}
			output.Table([]string{"KID", "ALG", "USE"}, rows)
		})
	},
}

func init() {
	jwksCmd.AddCommand(jwksGetCmd)
}
