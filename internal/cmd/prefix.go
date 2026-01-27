package cmd

import (
	"fmt"
	"strings"

	"github.com/spf13/cobra"
)

// expandPrefixArgs expands command prefixes to full command names
// e.g., "prot rul list" -> "protect rules list"
func expandPrefixArgs(cmd *cobra.Command, args []string) []string {
	if len(args) == 0 {
		return args
	}

	result := make([]string, 0, len(args))
	currentCmd := cmd

	for i := 0; i < len(args); i++ {
		arg := args[i]

		// Pass flags through as-is
		if strings.HasPrefix(arg, "-") {
			result = append(result, arg)
			// If it's a flag that takes a value (e.g. --profile foo), pass the value too
			if !strings.Contains(arg, "=") && i+1 < len(args) && !strings.HasPrefix(args[i+1], "-") {
				// Check if this flag expects a value on the current command
				flagName := strings.TrimLeft(arg, "-")
				if f := currentCmd.Flags().Lookup(flagName); f != nil && f.Value.Type() != "bool" {
					i++
					result = append(result, args[i])
				} else if f := currentCmd.PersistentFlags().Lookup(flagName); f != nil && f.Value.Type() != "bool" {
					i++
					result = append(result, args[i])
				}
			}
			continue
		}

		// Try to find a matching subcommand
		if currentCmd.HasSubCommands() {
			match, err := findSubcommandMatch(currentCmd, arg)
			if err != nil {
				// Ambiguous match - keep original and let cobra handle error
				result = append(result, args[i:]...)
				break
			}
			if match != nil {
				result = append(result, match.Name())
				currentCmd = match
				continue
			}
		}

		// No match found or not a subcommand - keep rest of args
		result = append(result, args[i:]...)
		break
	}

	return result
}

// findSubcommandMatch finds a subcommand that matches the given prefix
// Returns nil if no match, error if ambiguous
func findSubcommandMatch(cmd *cobra.Command, prefix string) (*cobra.Command, error) {
	prefix = strings.ToLower(prefix)
	var matches []*cobra.Command

	for _, sub := range cmd.Commands() {
		if sub.Hidden {
			continue
		}

		// Exact match
		if strings.ToLower(sub.Name()) == prefix {
			return sub, nil
		}

		// Check aliases for exact match
		for _, alias := range sub.Aliases {
			if strings.ToLower(alias) == prefix {
				return sub, nil
			}
		}

		// Prefix match on name
		if strings.HasPrefix(strings.ToLower(sub.Name()), prefix) {
			matches = append(matches, sub)
			continue
		}

		// Prefix match on aliases
		for _, alias := range sub.Aliases {
			if strings.HasPrefix(strings.ToLower(alias), prefix) {
				matches = append(matches, sub)
				break
			}
		}
	}

	if len(matches) == 0 {
		return nil, nil
	}

	if len(matches) == 1 {
		return matches[0], nil
	}

	// Ambiguous - collect names for error
	names := make([]string, len(matches))
	for i, m := range matches {
		names[i] = m.Name()
	}
	return nil, fmt.Errorf("ambiguous command %q matches: %s", prefix, strings.Join(names, ", "))
}

// EnablePrefixMatching recursively enables prefix matching for a command and its subcommands
func EnablePrefixMatching(cmd *cobra.Command) {
	// Set up args expansion for this command
	originalPreRun := cmd.PersistentPreRun
	cmd.PersistentPreRun = func(c *cobra.Command, args []string) {
		if originalPreRun != nil {
			originalPreRun(c, args)
		}
	}

	// Enable on all subcommands
	for _, sub := range cmd.Commands() {
		EnablePrefixMatching(sub)
	}
}
