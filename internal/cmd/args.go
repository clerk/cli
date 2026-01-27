package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
)

// RequireArg returns a cobra.PositionalArgs function that requires exactly 1 argument
// with a descriptive error message.
func RequireArg(name string) cobra.PositionalArgs {
	return func(cmd *cobra.Command, args []string) error {
		if len(args) < 1 {
			return fmt.Errorf("missing required argument: %s", name)
		}
		if len(args) > 1 {
			return fmt.Errorf("expected 1 argument (%s), got %d", name, len(args))
		}
		return nil
	}
}

// RequireArgs returns a cobra.PositionalArgs function that requires exactly N arguments
// with descriptive error messages for each.
func RequireArgs(names ...string) cobra.PositionalArgs {
	return func(cmd *cobra.Command, args []string) error {
		if len(args) < len(names) {
			missing := names[len(args):]
			if len(missing) == 1 {
				return fmt.Errorf("missing required argument: %s", missing[0])
			}
			return fmt.Errorf("missing required arguments: %s", formatArgList(missing))
		}
		if len(args) > len(names) {
			return fmt.Errorf("expected %d arguments (%s), got %d", len(names), formatArgList(names), len(args))
		}
		return nil
	}
}

// formatArgList formats a list of argument names for display
func formatArgList(names []string) string {
	if len(names) == 0 {
		return ""
	}
	if len(names) == 1 {
		return names[0]
	}
	result := names[0]
	for i := 1; i < len(names)-1; i++ {
		result += ", " + names[i]
	}
	result += " and " + names[len(names)-1]
	return result
}
