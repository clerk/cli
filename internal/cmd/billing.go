package cmd

import (
	"fmt"
	"time"

	"clerk.com/cli/internal/api"
	"clerk.com/cli/internal/output"
	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"
)

var billingCmd = &cobra.Command{
	Use:   "billing",
	Short: "Billing and subscriptions",
	Long:  "Manage billing plans, subscriptions, and statements.",
}

// Plans subcommand group
var billingPlansCmd = &cobra.Command{
	Use:   "plans",
	Short: "Billing plans",
	Long:  "Manage billing plans.",
}

var billingPlansListCmd = &cobra.Command{
	Use:     "list",
	Aliases: []string{"ls"},
	Short:   "List billing plans",
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		billingAPI := api.NewBillingAPI(client)

		limit, _ := cmd.Flags().GetInt("limit")
		offset, _ := cmd.Flags().GetInt("offset")

		plans, total, err := billingAPI.ListPlans(api.ListPlansParams{
			Limit:  limit,
			Offset: offset,
		})
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(map[string]interface{}{
			"data":        plans,
			"total_count": total,
		}, func() {
			if len(plans) == 0 {
				fmt.Println("No billing plans found")
				return
			}

			rows := make([][]string, len(plans))
			for i, p := range plans {
				amount := formatAmount(p.Amount, p.Currency)
				isDefault := ""
				if p.IsDefault {
					isDefault = "yes"
				}
				rows[i] = []string{p.ID, p.Name, p.Slug, amount, p.ForPayerType, isDefault}
			}
			output.Table([]string{"ID", "NAME", "SLUG", "AMOUNT", "PAYER TYPE", "DEFAULT"}, rows)
			fmt.Printf("\nTotal: %d\n", total)
		})
	},
}

// Subscription subcommand group
var billingSubscriptionCmd = &cobra.Command{
	Use:   "subscription",
	Short: "Subscriptions",
	Long:  "Manage billing subscriptions for users and organizations.",
}

var billingSubscriptionGetUserCmd = &cobra.Command{
	Use:   "get-user <user-id>",
	Short: "Get user subscription",
	Args:  RequireArg("user-id"),
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		billingAPI := api.NewBillingAPI(client)

		subscription, err := billingAPI.GetUserSubscription(args[0])
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(subscription, func() {
			printSubscription(subscription)
		})
	},
}

var billingSubscriptionGetOrgCmd = &cobra.Command{
	Use:   "get-org <organization-id>",
	Short: "Get organization subscription",
	Args:  RequireArg("organization-id"),
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		billingAPI := api.NewBillingAPI(client)

		subscription, err := billingAPI.GetOrganizationSubscription(args[0])
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(subscription, func() {
			printSubscription(subscription)
		})
	},
}

// Subscription items subcommand group
var billingSubscriptionItemsCmd = &cobra.Command{
	Use:     "subscription-items",
	Aliases: []string{"items"},
	Short:   "Subscription items",
	Long:    "Manage subscription items.",
}

var billingSubscriptionItemsListCmd = &cobra.Command{
	Use:     "list",
	Aliases: []string{"ls"},
	Short:   "List subscription items",
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		billingAPI := api.NewBillingAPI(client)

		limit, _ := cmd.Flags().GetInt("limit")
		offset, _ := cmd.Flags().GetInt("offset")

		items, total, err := billingAPI.ListSubscriptionItems(api.ListSubscriptionItemsParams{
			Limit:  limit,
			Offset: offset,
		})
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(map[string]interface{}{
			"data":        items,
			"total_count": total,
		}, func() {
			if len(items) == 0 {
				fmt.Println("No subscription items found")
				return
			}

			rows := make([][]string, len(items))
			for i, item := range items {
				planName := ""
				if item.Plan != nil {
					planName = item.Plan.Name
				}
				rows[i] = []string{item.ID, item.SubscriptionID, planName, item.Status, item.PlanPeriod}
			}
			output.Table([]string{"ID", "SUBSCRIPTION", "PLAN", "STATUS", "PERIOD"}, rows)
			fmt.Printf("\nTotal: %d\n", total)
		})
	},
}

var billingSubscriptionItemsDeleteCmd = &cobra.Command{
	Use:   "delete <subscription-item-id>",
	Short: "Delete subscription item",
	Args:  RequireArg("subscription-item-id"),
	RunE: func(cmd *cobra.Command, args []string) error {
		force, _ := cmd.Flags().GetBool("force")
		if !force && output.IsInteractive() {
			var confirm bool
			err := huh.NewConfirm().
				Title(fmt.Sprintf("Delete subscription item %s?", args[0])).
				Value(&confirm).
				Run()
			if err != nil {
				return err
			}
			if !confirm {
				fmt.Println("Cancelled")
				return nil
			}
		}

		client, err := GetClient()
		if err != nil {
			return err
		}
		billingAPI := api.NewBillingAPI(client)

		if err := billingAPI.DeleteSubscriptionItem(args[0]); err != nil {
			return err
		}

		output.Success(fmt.Sprintf("Deleted subscription item %s", args[0]))
		return nil
	},
}

var billingSubscriptionItemsExtendTrialCmd = &cobra.Command{
	Use:   "extend-trial <subscription-item-id>",
	Short: "Extend free trial",
	Args:  RequireArg("subscription-item-id"),
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		billingAPI := api.NewBillingAPI(client)

		days, _ := cmd.Flags().GetInt("days")

		item, err := billingAPI.ExtendFreeTrial(args[0], api.ExtendFreeTrialParams{
			Days: days,
		})
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(item, func() {
			output.Success(fmt.Sprintf("Extended trial for subscription item %s", item.ID))
			if item.PeriodEnd != nil && *item.PeriodEnd > 0 {
				fmt.Println(output.Dim("Period end:"), time.UnixMilli(*item.PeriodEnd).Format(time.RFC3339))
			}
		})
	},
}

var billingSubscriptionItemsTransitionPriceCmd = &cobra.Command{
	Use:   "transition-price <subscription-item-id>",
	Short: "Transition price",
	Args:  RequireArg("subscription-item-id"),
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		billingAPI := api.NewBillingAPI(client)

		priceID, _ := cmd.Flags().GetString("price-id")
		immediate, _ := cmd.Flags().GetBool("immediate")

		item, err := billingAPI.PriceTransition(args[0], api.PriceTransitionParams{
			PriceID:   priceID,
			Immediate: immediate,
		})
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(item, func() {
			output.Success(fmt.Sprintf("Transitioned price for subscription item %s", item.ID))
		})
	},
}

// Statements subcommand group
var billingStatementsCmd = &cobra.Command{
	Use:   "statements",
	Short: "Billing statements",
	Long:  "Manage billing statements.",
}

var billingStatementsListCmd = &cobra.Command{
	Use:     "list",
	Aliases: []string{"ls"},
	Short:   "List statements",
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		billingAPI := api.NewBillingAPI(client)

		limit, _ := cmd.Flags().GetInt("limit")
		offset, _ := cmd.Flags().GetInt("offset")

		statements, total, err := billingAPI.ListStatements(api.ListStatementsParams{
			Limit:  limit,
			Offset: offset,
		})
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(map[string]interface{}{
			"data":        statements,
			"total_count": total,
		}, func() {
			if len(statements) == 0 {
				fmt.Println("No statements found")
				return
			}

			rows := make([][]string, len(statements))
			for i, s := range statements {
				amount := formatAmount(s.Amount, s.Currency)
				dueDate := ""
				if s.DueDate > 0 {
					dueDate = time.UnixMilli(s.DueDate).Format("2006-01-02")
				}
				rows[i] = []string{s.ID, s.Status, amount, dueDate}
			}
			output.Table([]string{"ID", "STATUS", "AMOUNT", "DUE DATE"}, rows)
			fmt.Printf("\nTotal: %d\n", total)
		})
	},
}

var billingStatementsGetCmd = &cobra.Command{
	Use:   "get <statement-id>",
	Short: "Get statement details",
	Args:  RequireArg("statement-id"),
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		billingAPI := api.NewBillingAPI(client)

		statement, err := billingAPI.GetStatement(args[0])
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(statement, func() {
			fmt.Println(output.BoldYellow("Statement:"), statement.ID)
			fmt.Println(output.Dim("Status:"), statement.Status)
			fmt.Println(output.Dim("Amount:"), formatAmount(statement.Amount, statement.Currency))
			if statement.DueDate > 0 {
				fmt.Println(output.Dim("Due Date:"), time.UnixMilli(statement.DueDate).Format(time.RFC3339))
			}
			if statement.PaidAt > 0 {
				fmt.Println(output.Dim("Paid At:"), time.UnixMilli(statement.PaidAt).Format(time.RFC3339))
			}
			if statement.PeriodStart > 0 {
				fmt.Println(output.Dim("Period Start:"), time.UnixMilli(statement.PeriodStart).Format(time.RFC3339))
			}
			if statement.PeriodEnd > 0 {
				fmt.Println(output.Dim("Period End:"), time.UnixMilli(statement.PeriodEnd).Format(time.RFC3339))
			}
			fmt.Println(output.Dim("Created:"), time.UnixMilli(statement.CreatedAt).Format(time.RFC3339))
		})
	},
}

var billingStatementsPaymentAttemptsCmd = &cobra.Command{
	Use:   "payment-attempts <statement-id>",
	Short: "List payment attempts for statement",
	Args:  RequireArg("statement-id"),
	RunE: func(cmd *cobra.Command, args []string) error {
		client, err := GetClient()
		if err != nil {
			return err
		}
		billingAPI := api.NewBillingAPI(client)

		limit, _ := cmd.Flags().GetInt("limit")
		offset, _ := cmd.Flags().GetInt("offset")

		attempts, total, err := billingAPI.ListPaymentAttempts(args[0], api.ListPaymentAttemptsParams{
			Limit:  limit,
			Offset: offset,
		})
		if err != nil {
			return err
		}

		formatter := GetFormatter()
		return formatter.Output(map[string]interface{}{
			"data":        attempts,
			"total_count": total,
		}, func() {
			if len(attempts) == 0 {
				fmt.Println("No payment attempts found")
				return
			}

			rows := make([][]string, len(attempts))
			for i, a := range attempts {
				amount := formatAmount(a.Amount, a.Currency)
				created := ""
				if a.CreatedAt > 0 {
					created = time.UnixMilli(a.CreatedAt).Format("2006-01-02 15:04")
				}
				rows[i] = []string{a.ID, a.Status, amount, a.FailureReason, created}
			}
			output.Table([]string{"ID", "STATUS", "AMOUNT", "FAILURE REASON", "CREATED"}, rows)
			fmt.Printf("\nTotal: %d\n", total)
		})
	},
}

// Helper functions
func formatAmount(amount int64, currency string) string {
	if currency == "" {
		currency = "USD"
	}
	// Amount is typically in cents, convert to dollars
	dollars := float64(amount) / 100
	return fmt.Sprintf("%s %.2f", currency, dollars)
}

func printSubscription(s *api.Subscription) {
	fmt.Println(output.BoldYellow("Subscription:"), s.ID)
	fmt.Println(output.Dim("Status:"), s.Status)
	if s.PayerID != "" {
		fmt.Println(output.Dim("Payer ID:"), s.PayerID)
	}
	if s.ActiveAt != nil && *s.ActiveAt > 0 {
		fmt.Println(output.Dim("Active At:"), time.UnixMilli(*s.ActiveAt).Format(time.RFC3339))
	}
	fmt.Println(output.Dim("Eligible for Free Trial:"), s.EligibleForFreeTrial)
	if len(s.SubscriptionItems) > 0 {
		fmt.Println(output.Dim("Subscription Items:"), len(s.SubscriptionItems))
		for _, item := range s.SubscriptionItems {
			fmt.Printf("  - %s (%s)", item.ID, item.Status)
			if item.Plan != nil {
				fmt.Printf(" - %s", item.Plan.Name)
			}
			fmt.Println()
		}
	}
	fmt.Println(output.Dim("Created:"), time.UnixMilli(s.CreatedAt).Format(time.RFC3339))
}

func init() {
	// Plans flags
	billingPlansListCmd.Flags().Int("limit", 10, "Number of results to return")
	billingPlansListCmd.Flags().Int("offset", 0, "Offset for pagination")

	// Subscription items flags
	billingSubscriptionItemsListCmd.Flags().Int("limit", 10, "Number of results to return")
	billingSubscriptionItemsListCmd.Flags().Int("offset", 0, "Offset for pagination")

	billingSubscriptionItemsDeleteCmd.Flags().BoolP("force", "f", false, "Skip confirmation prompt")

	billingSubscriptionItemsExtendTrialCmd.Flags().Int("days", 0, "Number of days to extend")

	billingSubscriptionItemsTransitionPriceCmd.Flags().String("price-id", "", "New price ID")
	billingSubscriptionItemsTransitionPriceCmd.Flags().Bool("immediate", false, "Apply transition immediately")

	// Statements flags
	billingStatementsListCmd.Flags().Int("limit", 10, "Number of results to return")
	billingStatementsListCmd.Flags().Int("offset", 0, "Offset for pagination")

	billingStatementsPaymentAttemptsCmd.Flags().Int("limit", 10, "Number of results to return")
	billingStatementsPaymentAttemptsCmd.Flags().Int("offset", 0, "Offset for pagination")

	// Build command tree
	billingPlansCmd.AddCommand(billingPlansListCmd)

	billingSubscriptionCmd.AddCommand(billingSubscriptionGetUserCmd)
	billingSubscriptionCmd.AddCommand(billingSubscriptionGetOrgCmd)

	billingSubscriptionItemsCmd.AddCommand(billingSubscriptionItemsListCmd)
	billingSubscriptionItemsCmd.AddCommand(billingSubscriptionItemsDeleteCmd)
	billingSubscriptionItemsCmd.AddCommand(billingSubscriptionItemsExtendTrialCmd)
	billingSubscriptionItemsCmd.AddCommand(billingSubscriptionItemsTransitionPriceCmd)

	billingStatementsCmd.AddCommand(billingStatementsListCmd)
	billingStatementsCmd.AddCommand(billingStatementsGetCmd)
	billingStatementsCmd.AddCommand(billingStatementsPaymentAttemptsCmd)

	billingCmd.AddCommand(billingPlansCmd)
	billingCmd.AddCommand(billingSubscriptionCmd)
	billingCmd.AddCommand(billingSubscriptionItemsCmd)
	billingCmd.AddCommand(billingStatementsCmd)
}
