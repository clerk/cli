package cmd

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseFieldValue(t *testing.T) {
	tests := []struct {
		input   string
		key     string
		value   interface{}
		wantErr bool
	}{
		{"name=Ada", "name", "Ada", false},
		{"count=42", "count", 42, false},
		{"active=true", "active", true, false},
		{"deleted=false", "deleted", false, false},
		{"meta=null", "meta", nil, false},
		{"empty=", "empty", "", false},
		{"has=equals=sign", "has", "equals=sign", false},
		{"noequalssign", "", nil, true},
		{"=nokey", "", nil, true},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			f, err := parseFieldValue(tt.input)
			if tt.wantErr {
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if f.Key != tt.key {
				t.Errorf("key = %q, want %q", f.Key, tt.key)
			}
			if f.Value != tt.value {
				t.Errorf("value = %v (%T), want %v (%T)", f.Value, f.Value, tt.value, tt.value)
			}
		})
	}
}

func TestParseFieldValue_FileRef(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "data.txt")
	if err := os.WriteFile(path, []byte("file content\n"), 0644); err != nil {
		t.Fatal(err)
	}

	f, err := parseFieldValue("body=@" + path)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if f.Key != "body" {
		t.Errorf("key = %q, want %q", f.Key, "body")
	}
	if f.Value != "file content" {
		t.Errorf("value = %q, want %q", f.Value, "file content")
	}
}

func TestParseFieldValue_FileNotFound(t *testing.T) {
	_, err := parseFieldValue("body=@/nonexistent/file.txt")
	if err == nil {
		t.Fatal("expected error for missing file")
	}
}

func TestResolveMethod(t *testing.T) {
	tests := []struct {
		explicit string
		fields   []parsedField
		input    string
		want     string
	}{
		{"", nil, "", "GET"},
		{"", []parsedField{{Key: "k", Value: "v"}}, "", "POST"},
		{"", nil, "file.json", "POST"},
		{"PATCH", nil, "", "PATCH"},
		{"delete", nil, "", "DELETE"},
		{"put", []parsedField{{Key: "k", Value: "v"}}, "", "PUT"},
	}

	for _, tt := range tests {
		name := fmt.Sprintf("explicit=%q,fields=%d,input=%q", tt.explicit, len(tt.fields), tt.input)
		t.Run(name, func(t *testing.T) {
			got := resolveMethod(tt.explicit, tt.fields, tt.input)
			if got != tt.want {
				t.Errorf("resolveMethod() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestBuildURL(t *testing.T) {
	tests := []struct {
		endpoint string
		baseURL  string
		want     string
	}{
		{"/v1/users", "https://api.clerk.com", "https://api.clerk.com/v1/users"},
		{"v1/users", "https://api.clerk.com", "https://api.clerk.com/v1/users"},
		{"https://other.api.com/foo", "https://api.clerk.com", "https://other.api.com/foo"},
	}

	for _, tt := range tests {
		t.Run(tt.endpoint, func(t *testing.T) {
			got, err := buildURL(tt.endpoint, tt.baseURL)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tt.want {
				t.Errorf("buildURL() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestAppendQueryFields(t *testing.T) {
	fields := []parsedField{
		{Key: "limit", Value: 10},
		{Key: "active", Value: true},
	}

	got := appendQueryFields("https://api.clerk.com/v1/users", fields)
	if !strings.Contains(got, "limit=10") {
		t.Errorf("expected limit=10 in %q", got)
	}
	if !strings.Contains(got, "active=true") {
		t.Errorf("expected active=true in %q", got)
	}
}

func TestParseHeader(t *testing.T) {
	tests := []struct {
		input string
		key   string
		value string
		ok    bool
	}{
		{"Content-Type: application/json", "Content-Type", "application/json", true},
		{"X-Custom:value", "X-Custom", "value", true},
		{"no-colon", "", "", false},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			k, v, ok := parseHeader(tt.input)
			if ok != tt.ok {
				t.Fatalf("ok = %v, want %v", ok, tt.ok)
			}
			if !ok {
				return
			}
			if k != tt.key {
				t.Errorf("key = %q, want %q", k, tt.key)
			}
			if v != tt.value {
				t.Errorf("value = %q, want %q", v, tt.value)
			}
		})
	}
}

func TestParseLinkNext(t *testing.T) {
	tests := []struct {
		header string
		want   string
	}{
		{`<https://api.clerk.com/v1/users?offset=20>; rel="next"`, "https://api.clerk.com/v1/users?offset=20"},
		{`<https://api.clerk.com/v1/users?offset=0>; rel="prev", <https://api.clerk.com/v1/users?offset=20>; rel="next"`, "https://api.clerk.com/v1/users?offset=20"},
		{`<https://api.clerk.com/v1/users?offset=0>; rel="prev"`, ""},
		{"", ""},
	}

	for _, tt := range tests {
		t.Run(tt.header, func(t *testing.T) {
			got := parseLinkNext(tt.header)
			if got != tt.want {
				t.Errorf("parseLinkNext() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestRunAPI_GETRequest(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" {
			t.Errorf("expected GET, got %s", r.Method)
		}
		if r.Header.Get("Authorization") == "" {
			t.Error("missing Authorization header")
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `[{"id":"user_1","name":"Ada"}]`)
	}))
	defer server.Close()

	// Reset flags
	resetAPIFlags()
	apiSilent = true

	cmd := apiCmd
	cmd.SetArgs([]string{server.URL + "/v1/users"})

	// We need to set up the config for auth. Use env var.
	t.Setenv("CLERK_SECRET_KEY", "sk_test_xxx")

	err := cmd.RunE(cmd, []string{server.URL + "/v1/users"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestRunAPI_POSTWithFields(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			t.Errorf("expected POST, got %s", r.Method)
		}
		body, _ := io.ReadAll(r.Body)
		var m map[string]interface{}
		if err := json.Unmarshal(body, &m); err != nil {
			t.Fatalf("invalid JSON body: %v", err)
		}
		// Check typed fields
		if m["active"] != true {
			t.Errorf("expected active=true, got %v", m["active"])
		}
		if m["count"] != float64(42) {
			t.Errorf("expected count=42, got %v", m["count"])
		}
		if m["name"] != "Ada" {
			t.Errorf("expected name=Ada, got %v", m["name"])
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"id":"user_1"}`)
	}))
	defer server.Close()

	resetAPIFlags()
	apiFields = []string{"name=Ada", "active=true", "count=42"}
	apiSilent = true

	t.Setenv("CLERK_SECRET_KEY", "sk_test_xxx")

	err := apiCmd.RunE(apiCmd, []string{server.URL + "/v1/users"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestRunAPI_CustomHeaders(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("X-Custom"); got != "hello" {
			t.Errorf("X-Custom header = %q, want %q", got, "hello")
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{}`)
	}))
	defer server.Close()

	resetAPIFlags()
	apiHeaders = []string{"X-Custom: hello"}
	apiSilent = true

	t.Setenv("CLERK_SECRET_KEY", "sk_test_xxx")

	err := apiCmd.RunE(apiCmd, []string{server.URL + "/test"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestRunAPI_ExplicitMethod(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "DELETE" {
			t.Errorf("expected DELETE, got %s", r.Method)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{}`)
	}))
	defer server.Close()

	resetAPIFlags()
	apiMethod = "DELETE"
	apiSilent = true

	t.Setenv("CLERK_SECRET_KEY", "sk_test_xxx")

	err := apiCmd.RunE(apiCmd, []string{server.URL + "/v1/users/user_1"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestRunAPI_Paginate(t *testing.T) {
	callCount := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		callCount++
		w.Header().Set("Content-Type", "application/json")
		if callCount == 1 {
			nextURL := fmt.Sprintf("http://%s/v1/users?page=2", r.Host)
			w.Header().Set("Link", fmt.Sprintf(`<%s>; rel="next"`, nextURL))
			fmt.Fprint(w, `[{"id":"user_1"}]`)
		} else {
			fmt.Fprint(w, `[{"id":"user_2"}]`)
		}
	}))
	defer server.Close()

	resetAPIFlags()
	apiPaginate = true
	apiSilent = true

	t.Setenv("CLERK_SECRET_KEY", "sk_test_xxx")

	err := apiCmd.RunE(apiCmd, []string{server.URL + "/v1/users"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if callCount != 2 {
		t.Errorf("expected 2 requests, got %d", callCount)
	}
}

func TestRunAPI_PaginateSlurp(t *testing.T) {
	callCount := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		callCount++
		w.Header().Set("Content-Type", "application/json")
		if callCount == 1 {
			nextURL := fmt.Sprintf("http://%s/v1/users?page=2", r.Host)
			w.Header().Set("Link", fmt.Sprintf(`<%s>; rel="next"`, nextURL))
			fmt.Fprint(w, `[{"id":"user_1"}]`)
		} else {
			fmt.Fprint(w, `[{"id":"user_2"}]`)
		}
	}))
	defer server.Close()

	resetAPIFlags()
	apiPaginate = true
	apiSlurp = true

	t.Setenv("CLERK_SECRET_KEY", "sk_test_xxx")

	// Capture stdout
	old := os.Stdout
	r, w, _ := os.Pipe()
	os.Stdout = w

	err := apiCmd.RunE(apiCmd, []string{server.URL + "/v1/users"})

	w.Close()
	out, _ := io.ReadAll(r)
	os.Stdout = old

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var result []map[string]interface{}
	if err := json.Unmarshal(out, &result); err != nil {
		t.Fatalf("output is not valid JSON array: %v\noutput: %s", err, string(out))
	}
	if len(result) != 2 {
		t.Errorf("expected 2 items in slurped array, got %d", len(result))
	}
}

func TestRunAPI_HTTPError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(404)
		fmt.Fprint(w, `{"errors":[{"message":"not found"}]}`)
	}))
	defer server.Close()

	resetAPIFlags()
	apiSilent = true

	t.Setenv("CLERK_SECRET_KEY", "sk_test_xxx")

	err := apiCmd.RunE(apiCmd, []string{server.URL + "/v1/users/nope"})
	if err == nil {
		t.Fatal("expected error for 404")
	}
	if !strings.Contains(err.Error(), "404") {
		t.Errorf("error should mention 404, got: %v", err)
	}
}

func TestRunAPI_SlurpWithoutPaginate(t *testing.T) {
	resetAPIFlags()
	apiSlurp = true

	t.Setenv("CLERK_SECRET_KEY", "sk_test_xxx")

	err := apiCmd.RunE(apiCmd, []string{"https://example.com/test"})
	if err == nil || !strings.Contains(err.Error(), "--slurp requires --paginate") {
		t.Errorf("expected --slurp requires --paginate error, got: %v", err)
	}
}

func TestRunAPI_InputFromFile(t *testing.T) {
	dir := t.TempDir()
	inputFile := filepath.Join(dir, "body.json")
	if err := os.WriteFile(inputFile, []byte(`{"custom":"body"}`), 0644); err != nil {
		t.Fatal(err)
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			t.Errorf("expected POST, got %s", r.Method)
		}
		body, _ := io.ReadAll(r.Body)
		if string(body) != `{"custom":"body"}` {
			t.Errorf("unexpected body: %s", string(body))
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"ok":true}`)
	}))
	defer server.Close()

	resetAPIFlags()
	apiInput = inputFile
	apiSilent = true

	t.Setenv("CLERK_SECRET_KEY", "sk_test_xxx")

	err := apiCmd.RunE(apiCmd, []string{server.URL + "/v1/test"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestRunAPI_GETWithFieldsAsQuery(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" {
			t.Errorf("expected GET, got %s", r.Method)
		}
		if got := r.URL.Query().Get("limit"); got != "10" {
			t.Errorf("expected limit=10, got %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `[]`)
	}))
	defer server.Close()

	resetAPIFlags()
	apiFields = []string{"limit=10"}
	apiMethod = "GET"
	apiSilent = true

	t.Setenv("CLERK_SECRET_KEY", "sk_test_xxx")

	err := apiCmd.RunE(apiCmd, []string{server.URL + "/v1/users"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestRunAPI_JQ(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `[{"name":"Ada"},{"name":"Grace"}]`)
	}))
	defer server.Close()

	resetAPIFlags()
	apiJQ = ".[].name"

	t.Setenv("CLERK_SECRET_KEY", "sk_test_xxx")

	// Capture stdout
	old := os.Stdout
	r, w, _ := os.Pipe()
	os.Stdout = w

	err := apiCmd.RunE(apiCmd, []string{server.URL + "/v1/users"})

	w.Close()
	out, _ := io.ReadAll(r)
	os.Stdout = old

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	lines := strings.TrimSpace(string(out))
	if lines != "Ada\nGrace" {
		t.Errorf("jq output = %q, want %q", lines, "Ada\nGrace")
	}
}

func TestIsPlatformEndpoint(t *testing.T) {
	tests := []struct {
		endpoint string
		want     bool
	}{
		{"/v1/platform/applications", true},
		{"/v1/platform/applications?limit=10", true},
		{"v1/platform/transfers", true},
		{"https://api.clerk.com/v1/platform/applications", true},
		{"/v1/users", false},
		{"/v1/platformish", false},
		{"https://api.clerk.com/v1/users", false},
	}

	for _, tt := range tests {
		t.Run(tt.endpoint, func(t *testing.T) {
			got := isPlatformEndpoint(tt.endpoint)
			if got != tt.want {
				t.Errorf("isPlatformEndpoint(%q) = %v, want %v", tt.endpoint, got, tt.want)
			}
		})
	}
}

func TestRunAPI_PlatformAutoDetect(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		if auth != "Bearer ak_test_xxx" {
			t.Errorf("expected platform key, got Authorization: %s", auth)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `[]`)
	}))
	defer server.Close()

	resetAPIFlags()
	apiSilent = true

	t.Setenv("CLERK_PLATFORM_KEY", "ak_test_xxx")
	t.Setenv("CLERK_SECRET_KEY", "sk_test_yyy")

	// Use an absolute URL so buildURL doesn't prepend the base, but the path
	// still contains /v1/platform so auto-detection kicks in
	err := apiCmd.RunE(apiCmd, []string{server.URL + "/v1/platform/applications"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestRunAPI_PlatformFlag(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		if auth != "Bearer ak_test_xxx" {
			t.Errorf("expected platform key, got Authorization: %s", auth)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{}`)
	}))
	defer server.Close()

	resetAPIFlags()
	apiPlatform = true
	apiSilent = true

	t.Setenv("CLERK_PLATFORM_KEY", "ak_test_xxx")
	t.Setenv("CLERK_SECRET_KEY", "sk_test_yyy")

	err := apiCmd.RunE(apiCmd, []string{server.URL + "/v1/some/custom/endpoint"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func resetAPIFlags() {
	apiFields = nil
	apiHeaders = nil
	apiInput = ""
	apiJQ = ""
	apiMethod = ""
	apiPaginate = false
	apiPlatform = false
	apiSilent = false
	apiSlurp = false
	apiTmpl = ""
	apiVerbose = false
}
