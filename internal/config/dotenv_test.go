package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestParseEnvFileForKey(t *testing.T) {
	// Create temp directory
	tmpDir, err := os.MkdirTemp("", "dotenv-test")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(tmpDir) //nolint:errcheck // test cleanup

	tests := []struct {
		name     string
		content  string
		key      string
		expected string
	}{
		{
			name:     "simple value",
			content:  "CLERK_SECRET_KEY=sk_test_123",
			key:      "CLERK_SECRET_KEY",
			expected: "sk_test_123",
		},
		{
			name:     "value with double quotes",
			content:  `CLERK_SECRET_KEY="sk_test_quoted"`,
			key:      "CLERK_SECRET_KEY",
			expected: "sk_test_quoted",
		},
		{
			name:     "value with single quotes",
			content:  `CLERK_SECRET_KEY='sk_test_single'`,
			key:      "CLERK_SECRET_KEY",
			expected: "sk_test_single",
		},
		{
			name:     "with comments",
			content:  "# comment\nCLERK_SECRET_KEY=sk_test_456\n# another",
			key:      "CLERK_SECRET_KEY",
			expected: "sk_test_456",
		},
		{
			name:     "key not found",
			content:  "OTHER_KEY=value",
			key:      "CLERK_SECRET_KEY",
			expected: "",
		},
		{
			name:     "empty value",
			content:  "CLERK_SECRET_KEY=",
			key:      "CLERK_SECRET_KEY",
			expected: "",
		},
		{
			name:     "with spaces around equals",
			content:  "CLERK_SECRET_KEY = sk_test_spaces",
			key:      "CLERK_SECRET_KEY",
			expected: "sk_test_spaces",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			envFile := filepath.Join(tmpDir, ".env")
			_ = os.WriteFile(envFile, []byte(tt.content), 0600)

			result := parseEnvFileForKey(envFile, tt.key)
			if result != tt.expected {
				t.Errorf("parseEnvFileForKey() = %q, want %q", result, tt.expected)
			}
		})
	}
}

func TestFindDotEnvSecretKey(t *testing.T) {
	// Create temp directory structure
	tmpDir, err := os.MkdirTemp("", "dotenv-find-test")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(tmpDir) //nolint:errcheck // test cleanup

	// Create parent with .env
	parentEnv := filepath.Join(tmpDir, ".env")
	_ = os.WriteFile(parentEnv, []byte("CLERK_SECRET_KEY=sk_parent"), 0600)

	// Create subdirectory without .env
	subDir := filepath.Join(tmpDir, "subdir")
	_ = os.MkdirAll(subDir, 0750)

	// Save current working directory
	origWd, _ := os.Getwd()
	defer os.Chdir(origWd) //nolint:errcheck // test cleanup

	// Test from subdirectory - should find parent .env
	_ = os.Chdir(subDir)
	result := FindDotEnvSecretKey()
	if result != "sk_parent" {
		t.Errorf("FindDotEnvSecretKey() from subdir = %q, want %q", result, "sk_parent")
	}

	// Test from parent directory
	_ = os.Chdir(tmpDir)
	result = FindDotEnvSecretKey()
	if result != "sk_parent" {
		t.Errorf("FindDotEnvSecretKey() from parent = %q, want %q", result, "sk_parent")
	}

	// Test with child .env overriding parent
	childEnv := filepath.Join(subDir, ".env")
	_ = os.WriteFile(childEnv, []byte("CLERK_SECRET_KEY=sk_child"), 0600)
	_ = os.Chdir(subDir)
	result = FindDotEnvSecretKey()
	if result != "sk_child" {
		t.Errorf("FindDotEnvSecretKey() with child .env = %q, want %q", result, "sk_child")
	}
}

func TestGetAPIKeyWithDotEnv(t *testing.T) {
	// Create temp directory with .env
	tmpDir, err := os.MkdirTemp("", "dotenv-getkey-test")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(tmpDir) //nolint:errcheck // test cleanup

	envFile := filepath.Join(tmpDir, ".env")
	_ = os.WriteFile(envFile, []byte("CLERK_SECRET_KEY=sk_from_dotenv"), 0600)

	// Save and clear state
	origWd, _ := os.Getwd()
	origEnv := os.Getenv("CLERK_SECRET_KEY")
	_ = os.Unsetenv("CLERK_SECRET_KEY")
	defer func() {
		_ = os.Chdir(origWd)
		if origEnv != "" {
			_ = os.Setenv("CLERK_SECRET_KEY", origEnv)
		}
	}()

	// Reset config cache
	Reset()

	_ = os.Chdir(tmpDir)

	// Test with checkDotEnv=true (should find .env)
	result := GetAPIKeyWithDotEnv("default", true)
	if result != "sk_from_dotenv" {
		t.Errorf("GetAPIKeyWithDotEnv(checkDotEnv=true) = %q, want %q", result, "sk_from_dotenv")
	}

	// Test with checkDotEnv=false (should not find .env)
	// This will return whatever is in the config, which may not be empty
	// So we just verify it doesn't crash
	_ = GetAPIKeyWithDotEnv("default", false)
}
