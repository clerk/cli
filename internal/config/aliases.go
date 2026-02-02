package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

var aliasesFile string

func init() {
	homeDir, _ := os.UserHomeDir()
	if homeDir == "" {
		homeDir = "."
	}
	aliasesFile = filepath.Join(homeDir, ".config", "clerk", "cli", "aliases.json")
}

func AliasesFile() string { return aliasesFile }

type Aliases map[string]string

func LoadAliases() (Aliases, error) {
	aliases := make(Aliases)

	data, err := os.ReadFile(aliasesFile) // #nosec G304 -- aliases file path is from known config location
	if err != nil {
		if os.IsNotExist(err) {
			return aliases, nil
		}
		return nil, err
	}

	if err := json.Unmarshal(data, &aliases); err != nil {
		return nil, err
	}

	return aliases, nil
}

func SaveAliases(aliases Aliases) error {
	if err := EnsureConfigDir(); err != nil {
		return err
	}

	data, err := json.MarshalIndent(aliases, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(aliasesFile, data, 0600)
}

func AddAlias(name, command string) error {
	aliases, err := LoadAliases()
	if err != nil {
		return err
	}
	aliases[name] = command
	return SaveAliases(aliases)
}

func RemoveAlias(name string) error {
	aliases, err := LoadAliases()
	if err != nil {
		return err
	}
	delete(aliases, name)
	return SaveAliases(aliases)
}

func GetAlias(name string) (string, bool) {
	aliases, _ := LoadAliases()
	cmd, ok := aliases[name]
	return cmd, ok
}

func ExpandAlias(args []string) ([]string, bool) {
	if len(args) == 0 {
		return args, false
	}

	aliases, err := LoadAliases()
	if err != nil {
		return args, false
	}

	aliasCmd, ok := aliases[args[0]]
	if !ok {
		return args, false
	}

	expandedParts := strings.Fields(aliasCmd)
	expandedArgs := append(expandedParts, args[1:]...)
	return expandedArgs, true
}
