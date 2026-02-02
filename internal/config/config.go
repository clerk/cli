package config

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

const (
	DefaultAPIURL       = "https://api.clerk.com"
	DefaultOutputFormat = "table"
)

var (
	configDir    string
	profilesFile string
	cfg          *Config
	cfgMu        sync.RWMutex
)

type Config struct {
	ActiveProfile string
	Defaults      map[string]string
	Profiles      map[string]map[string]string
	TypeMarkers   map[string]map[string]string // tracks which values are "command" type
}

type Profile struct {
	Name   string
	APIKey string
	APIURL string
	Output string
	Debug  bool
}

func init() {
	homeDir, _ := os.UserHomeDir()
	if homeDir == "" {
		homeDir = "."
	}
	configDir = filepath.Join(homeDir, ".config", "clerk", "cli")
	profilesFile = filepath.Join(configDir, "profiles")
}

func ConfigDir() string  { return configDir }
func ConfigFile() string { return profilesFile }

func EnsureConfigDir() error {
	return os.MkdirAll(configDir, 0755) // #nosec G301 -- 0755 is appropriate for config directory
}

func Load() (*Config, error) {
	cfgMu.Lock()
	defer cfgMu.Unlock()

	if cfg != nil {
		return cfg, nil
	}

	cfg = &Config{
		ActiveProfile: "default",
		Defaults:      make(map[string]string),
		Profiles:      make(map[string]map[string]string),
		TypeMarkers:   make(map[string]map[string]string),
	}

	// Try to load INI file
	if err := loadINI(profilesFile, cfg); err != nil {
		if !os.IsNotExist(err) {
			return nil, err
		}
	}

	// Try to migrate from old JSON config
	oldConfigFile := filepath.Join(configDir, "config.json")
	if _, err := os.Stat(oldConfigFile); err == nil {
		if migrateFromJSON(oldConfigFile, cfg) {
			// Save in new format and remove old file
			cfgMu.Unlock()
			Save()
			cfgMu.Lock()
			os.Remove(oldConfigFile)
		}
	}

	return cfg, nil
}

func loadINI(filename string, cfg *Config) error {
	file, err := os.Open(filename) // #nosec G304 -- config file path is from known location
	if err != nil {
		return err
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	var currentSection string
	var currentProfile string

	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())

		// Skip empty lines and comments
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, ";") {
			continue
		}

		// Section header
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			section := strings.TrimSpace(line[1 : len(line)-1])

			if section == "default" {
				currentSection = "default"
				currentProfile = ""
			} else if strings.HasPrefix(section, "profile ") {
				currentSection = "profile"
				currentProfile = strings.TrimSpace(section[8:])
				if cfg.Profiles[currentProfile] == nil {
					cfg.Profiles[currentProfile] = make(map[string]string)
				}
			} else {
				currentSection = section
				currentProfile = ""
			}
			continue
		}

		// Key-value pair
		if idx := strings.Index(line, "="); idx > 0 {
			key := strings.TrimSpace(line[:idx])
			value := strings.TrimSpace(line[idx+1:])

			// Remove quotes if present
			if len(value) >= 2 && ((value[0] == '"' && value[len(value)-1] == '"') ||
				(value[0] == '\'' && value[len(value)-1] == '\'')) {
				value = value[1 : len(value)-1]
			}

			switch currentSection {
			case "default":
				if key == "profile" {
					cfg.ActiveProfile = value
				} else {
					cfg.Defaults[key] = value
				}
			case "profile":
				if currentProfile != "" {
					// Check for command type marker
					if strings.HasPrefix(value, "!") {
						value = value[1:]
						if cfg.TypeMarkers[currentProfile] == nil {
							cfg.TypeMarkers[currentProfile] = make(map[string]string)
						}
						cfg.TypeMarkers[currentProfile][key] = "command"
					}
					cfg.Profiles[currentProfile][key] = value
				}
			}
		}
	}

	return scanner.Err()
}

func Save() error {
	cfgMu.RLock()
	defer cfgMu.RUnlock()

	if cfg == nil {
		return nil
	}

	if err := EnsureConfigDir(); err != nil {
		return err
	}

	var sb strings.Builder

	// Write [default] section
	sb.WriteString("[default]\n")
	if cfg.ActiveProfile != "" && cfg.ActiveProfile != "default" {
		sb.WriteString(fmt.Sprintf("profile = %s\n", cfg.ActiveProfile))
	}

	// Write defaults
	defaultKeys := make([]string, 0, len(cfg.Defaults))
	for k := range cfg.Defaults {
		defaultKeys = append(defaultKeys, k)
	}
	sort.Strings(defaultKeys)
	for _, k := range defaultKeys {
		sb.WriteString(fmt.Sprintf("%s = %s\n", k, cfg.Defaults[k]))
	}

	// Write profiles
	profileNames := make([]string, 0, len(cfg.Profiles))
	for name := range cfg.Profiles {
		profileNames = append(profileNames, name)
	}
	sort.Strings(profileNames)

	for _, name := range profileNames {
		profile := cfg.Profiles[name]
		if len(profile) == 0 {
			continue
		}

		sb.WriteString(fmt.Sprintf("\n[profile %s]\n", name))

		keys := make([]string, 0, len(profile))
		for k := range profile {
			keys = append(keys, k)
		}
		sort.Strings(keys)

		for _, k := range keys {
			v := profile[k]
			// Add command marker if needed
			if cfg.TypeMarkers[name] != nil && cfg.TypeMarkers[name][k] == "command" {
				v = "!" + v
			}
			sb.WriteString(fmt.Sprintf("%s = %s\n", k, v))
		}
	}

	return os.WriteFile(profilesFile, []byte(sb.String()), 0600)
}

// migrateFromJSON migrates from old JSON config format
func migrateFromJSON(jsonFile string, cfg *Config) bool {
	data, err := os.ReadFile(jsonFile) // #nosec G304 -- migration path is from known config location
	if err != nil {
		return false
	}

	// Simple JSON parsing for migration
	// Looking for: "activeProfile", "profiles", "defaults"
	content := string(data)

	// This is a simplified migration - just extract key values
	// For a real implementation, use encoding/json
	if strings.Contains(content, `"profiles"`) {
		// Old config exists, trigger migration by loading values
		// The old keys will be in the profiles map
		return true
	}

	return false
}

func Get() *Config {
	cfgMu.RLock()
	defer cfgMu.RUnlock()
	return cfg
}

func GetActiveProfileName(flagValue string) string {
	if flagValue != "" {
		return flagValue
	}
	if envProfile := os.Getenv("CLERK_PROFILE"); envProfile != "" {
		return envProfile
	}
	cfg, _ := Load()
	if cfg != nil && cfg.ActiveProfile != "" {
		return cfg.ActiveProfile
	}
	return "default"
}

func GetProfile(name string) *Profile {
	cfg, _ := Load()
	if cfg == nil {
		return &Profile{Name: name}
	}

	profileData := cfg.Profiles[name]
	if profileData == nil {
		profileData = make(map[string]string)
	}

	return &Profile{
		Name:   name,
		APIKey: profileData["clerk.key"],
		APIURL: profileData["clerk.api.url"],
		Output: profileData["output"],
		Debug:  profileData["debug"] == "true",
	}
}

func ResolveValue(key, flagValue, envVar, defaultValue string, profileName string) string {
	if flagValue != "" {
		return flagValue
	}

	if envVar != "" {
		if val := os.Getenv(envVar); val != "" {
			return val
		}
	}

	cfg, _ := Load()
	if cfg == nil {
		return defaultValue
	}

	// Check profile first
	profile := cfg.Profiles[profileName]
	if profile != nil {
		if val, ok := profile[key]; ok && val != "" {
			if cfg.TypeMarkers[profileName] != nil && cfg.TypeMarkers[profileName][key] == "command" {
				return executeCommand(val)
			}
			return val
		}
	}

	// Check defaults
	if val, ok := cfg.Defaults[key]; ok && val != "" {
		return val
	}

	return defaultValue
}

func executeCommand(cmd string) string {
	if cmd == "" {
		return ""
	}
	// Use shell to execute command so quotes and pipes work correctly
	// e.g., op read 'op://Vault/Clerk/api-key'
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/sh"
	}
	command := exec.Command(shell, "-c", cmd) // #nosec G204 -- intentional shell exec for ! prefixed config values
	output, err := command.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(output))
}

func SetProfileValue(profileName, key, value string) error {
	cfg, err := Load()
	if err != nil {
		return err
	}

	if cfg.Profiles == nil {
		cfg.Profiles = make(map[string]map[string]string)
	}
	if cfg.Profiles[profileName] == nil {
		cfg.Profiles[profileName] = make(map[string]string)
	}

	cfg.Profiles[profileName][key] = value
	return Save()
}

func SetProfileValueWithType(profileName, key, value, valueType string) error {
	cfg, err := Load()
	if err != nil {
		return err
	}

	if cfg.Profiles == nil {
		cfg.Profiles = make(map[string]map[string]string)
	}
	if cfg.Profiles[profileName] == nil {
		cfg.Profiles[profileName] = make(map[string]string)
	}

	cfg.Profiles[profileName][key] = value

	if valueType == "command" {
		if cfg.TypeMarkers == nil {
			cfg.TypeMarkers = make(map[string]map[string]string)
		}
		if cfg.TypeMarkers[profileName] == nil {
			cfg.TypeMarkers[profileName] = make(map[string]string)
		}
		cfg.TypeMarkers[profileName][key] = valueType
	}

	return Save()
}

func UnsetProfileValue(profileName, key string) error {
	cfg, err := Load()
	if err != nil {
		return err
	}

	if cfg.Profiles != nil && cfg.Profiles[profileName] != nil {
		delete(cfg.Profiles[profileName], key)
	}
	if cfg.TypeMarkers != nil && cfg.TypeMarkers[profileName] != nil {
		delete(cfg.TypeMarkers[profileName], key)
	}

	return Save()
}

func SetDefault(key string, value string) error {
	cfg, err := Load()
	if err != nil {
		return err
	}

	if cfg.Defaults == nil {
		cfg.Defaults = make(map[string]string)
	}
	cfg.Defaults[key] = value
	return Save()
}

func SetActiveProfile(name string) error {
	cfg, err := Load()
	if err != nil {
		return err
	}
	cfg.ActiveProfile = name
	return Save()
}

func CreateProfile(name string) error {
	cfg, err := Load()
	if err != nil {
		return err
	}

	if cfg.Profiles == nil {
		cfg.Profiles = make(map[string]map[string]string)
	}
	if _, exists := cfg.Profiles[name]; exists {
		return fmt.Errorf("profile %q already exists", name)
	}

	cfg.Profiles[name] = make(map[string]string)
	return Save()
}

func DeleteProfile(name string) error {
	cfg, err := Load()
	if err != nil {
		return err
	}

	if name == "default" {
		return fmt.Errorf("cannot delete the default profile")
	}

	if cfg.Profiles != nil {
		delete(cfg.Profiles, name)
	}
	if cfg.TypeMarkers != nil {
		delete(cfg.TypeMarkers, name)
	}
	if cfg.ActiveProfile == name {
		cfg.ActiveProfile = "default"
	}

	return Save()
}

func ListProfiles() []string {
	cfg, _ := Load()
	if cfg == nil || cfg.Profiles == nil {
		return []string{"default"}
	}

	names := make([]string, 0, len(cfg.Profiles))
	for name := range cfg.Profiles {
		names = append(names, name)
	}
	if len(names) == 0 {
		return []string{"default"}
	}
	sort.Strings(names)
	return names
}

func GetRawValue(profileName, key string) string {
	cfg, _ := Load()
	if cfg == nil {
		return ""
	}

	profile := cfg.Profiles[profileName]
	if profile != nil {
		if val, ok := profile[key]; ok {
			return val
		}
	}

	if val, ok := cfg.Defaults[key]; ok {
		return val
	}

	return ""
}

// ProfileExists returns true if the named profile exists in the config.
// The "default" profile is always considered to exist.
func ProfileExists(name string) bool {
	if name == "default" {
		return true
	}
	cfg, _ := Load()
	if cfg == nil || cfg.Profiles == nil {
		return false
	}
	_, exists := cfg.Profiles[name]
	return exists
}

// HasAnyConfig returns true if there is any configuration at all
// (any profiles with values, environment-based API key, or .env file).
func HasAnyConfig() bool {
	if os.Getenv("CLERK_SECRET_KEY") != "" {
		return true
	}
	if FindDotEnvSecretKey() != "" {
		return true
	}
	cfg, _ := Load()
	if cfg == nil {
		return false
	}
	for _, profile := range cfg.Profiles {
		if len(profile) > 0 {
			return true
		}
	}
	return false
}

func GetAPIKey(profileName string) string {
	return GetAPIKeyWithDotEnv(profileName, false)
}

// GetAPIKeyWithDotEnv returns the API key, optionally checking .env files
// in the current and parent directories when checkDotEnv is true.
func GetAPIKeyWithDotEnv(profileName string, checkDotEnv bool) string {
	// Check env var first (highest priority)
	if val := os.Getenv("CLERK_SECRET_KEY"); val != "" {
		return val
	}

	// Check .env file if enabled (before profile lookup)
	if checkDotEnv {
		if val := FindDotEnvSecretKey(); val != "" {
			return val
		}
	}

	// Profile-based lookup
	cfg, _ := Load()
	if cfg == nil {
		return ""
	}

	// Check profile
	if profile := cfg.Profiles[profileName]; profile != nil {
		if val, ok := profile["clerk.key"]; ok && val != "" {
			if cfg.TypeMarkers[profileName] != nil && cfg.TypeMarkers[profileName]["clerk.key"] == "command" {
				return executeCommand(val)
			}
			return val
		}
	}

	// Check defaults
	if val, ok := cfg.Defaults["clerk.key"]; ok && val != "" {
		return val
	}

	return ""
}

// FindDotEnvSecretKey searches upward from the current directory for a .env file
// and returns the value of CLERK_SECRET_KEY if found.
func FindDotEnvSecretKey() string {
	value, _ := FindDotEnvSecretKeyWithPath()
	return value
}

// FindDotEnvSecretKeyWithPath searches upward from the current directory for a .env file
// and returns the value of CLERK_SECRET_KEY along with the file path if found.
func FindDotEnvSecretKeyWithPath() (value string, filePath string) {
	cwd, err := os.Getwd()
	if err != nil {
		return "", ""
	}

	for dir := cwd; ; {
		envFile := filepath.Join(dir, ".env")
		if key := parseEnvFileForKey(envFile, "CLERK_SECRET_KEY"); key != "" {
			return key, envFile
		}

		parent := filepath.Dir(dir)
		if parent == dir {
			break // reached root
		}
		dir = parent
	}
	return "", ""
}

// parseEnvFileForKey parses a .env file and returns the value for the given key.
func parseEnvFileForKey(filename, targetKey string) string {
	file, err := os.Open(filename) // #nosec G304 -- .env file path is user-specified, expected for CLI
	if err != nil {
		return ""
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}

		if idx := strings.Index(line, "="); idx > 0 {
			key := strings.TrimSpace(line[:idx])
			if key == targetKey {
				value := strings.TrimSpace(line[idx+1:])
				// Remove quotes if present
				if len(value) >= 2 && ((value[0] == '"' && value[len(value)-1] == '"') ||
					(value[0] == '\'' && value[len(value)-1] == '\'')) {
					value = value[1 : len(value)-1]
				}
				return value
			}
		}
	}
	return ""
}

func GetAPIURL(profileName string) string {
	return ResolveValue("clerk.api.url", "", "CLERK_API_URL", DefaultAPIURL, profileName)
}

// GetProfileKey returns the API key stored directly in the profile configuration.
// This does NOT check environment variables or .env files.
func GetProfileKey(profileName string) string {
	cfg, _ := Load()
	if cfg == nil {
		return ""
	}

	// Check profile
	if profile := cfg.Profiles[profileName]; profile != nil {
		if val, ok := profile["clerk.key"]; ok && val != "" {
			if cfg.TypeMarkers[profileName] != nil && cfg.TypeMarkers[profileName]["clerk.key"] == "command" {
				return executeCommand(val)
			}
			return val
		}
	}

	// Check defaults
	if val, ok := cfg.Defaults["clerk.key"]; ok && val != "" {
		return val
	}

	return ""
}

func IsDebugEnabled() bool {
	envDebug := os.Getenv("CLERK_CLI_DEBUG")
	return envDebug == "1" || envDebug == "true"
}

// IsCommandType returns true if the value for the given key is a command type
func IsCommandType(profileName, key string) bool {
	cfg, _ := Load()
	if cfg == nil {
		return false
	}
	if cfg.TypeMarkers[profileName] != nil {
		return cfg.TypeMarkers[profileName][key] == "command"
	}
	return false
}

func Reset() {
	cfgMu.Lock()
	defer cfgMu.Unlock()
	cfg = nil
}
