package cmd

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"text/template"

	"github.com/itchyny/gojq"
	"github.com/spf13/cobra"

	"clerk.com/cli/internal/api"
	"clerk.com/cli/internal/config"
	"clerk.com/cli/internal/output"
)

var (
	apiFields   []string
	apiHeaders  []string
	apiInput    string
	apiJQ       string
	apiMethod   string
	apiSilent   bool
	apiSlurp    bool
	apiTmpl     string
	apiVerbose  bool
	apiPaginate bool
	apiPlatform bool
)

var apiCmd = &cobra.Command{
	Use:   "api <endpoint>",
	Short: "Make an authenticated API request",
	Long: `Make an authenticated HTTP request to the Clerk API.

The endpoint argument is appended to the base API URL (https://api.clerk.com).
Pass a path like /v1/users or an absolute URL.

By default, the request method is GET. If any --field flags are provided and no
--method is specified, the method switches to POST.

Fields (-F) support automatic type detection:
  - "true" / "false"       → JSON boolean
  - integer literals        → JSON number
  - "null"                  → JSON null
  - "@filename"             → contents of file
  - everything else         → JSON string

For GET requests, fields are sent as query parameters (always as strings).
For other methods, fields are sent as a JSON request body with typed values.
When --input is specified, fields are always sent as query parameters.`,
	Example: `  # List users
  clerk api /v1/users

  # Create a user with typed fields
  clerk api /v1/users -F first_name=Ada -F last_name=Lovelace

  # Use jq to extract emails
  clerk api /v1/users -q '.[].email_addresses[].email_address'

  # PATCH with explicit method
  clerk api -X PATCH /v1/users/user_xxx -F first_name=Grace

  # Paginate through all results
  clerk api /v1/users --paginate

  # Pipe request body from stdin
  echo '{"first_name":"Ada"}' | clerk api -X POST /v1/users --input -

  # Verbose output showing headers
  clerk api /v1/users --verbose

  # Platform API (auto-detected from /v1/platform path, uses ak_* key)
  clerk api /v1/platform/applications

  # Explicit platform key for non-standard paths
  clerk api --platform /some/endpoint`,
	Args: cobra.ExactArgs(1),
	RunE: runAPI,
}

func init() {
	apiCmd.Flags().StringArrayVarP(&apiFields, "field", "F", nil, "Add a typed request field (key=value)")
	apiCmd.Flags().StringArrayVarP(&apiHeaders, "header", "H", nil, "Add a custom HTTP header (key:value)")
	apiCmd.Flags().StringVar(&apiInput, "input", "", "Read request body from file (use - for stdin)")
	apiCmd.Flags().StringVarP(&apiJQ, "jq", "q", "", "Filter JSON output with a jq expression")
	apiCmd.Flags().StringVarP(&apiMethod, "method", "X", "", "HTTP method (default: GET, or POST with fields)")
	apiCmd.Flags().BoolVar(&apiPaginate, "paginate", false, "Fetch all pages of results automatically")
	apiCmd.Flags().BoolVar(&apiSilent, "silent", false, "Do not print the response body")
	apiCmd.Flags().BoolVar(&apiSlurp, "slurp", false, "With --paginate, collect all pages into a JSON array")
	apiCmd.Flags().StringVarP(&apiTmpl, "template", "t", "", "Format output with a Go template")
	apiCmd.Flags().BoolVar(&apiVerbose, "verbose", false, "Show HTTP request and response headers")
	apiCmd.Flags().BoolVar(&apiPlatform, "platform", false, "Use Platform API key (ak_*) instead of Backend API key (sk_*)")
}

// parsedField holds a key and its typed JSON value.
type parsedField struct {
	Key   string
	Value interface{}
}

func parseFieldValue(raw string) (parsedField, error) {
	eq := strings.IndexByte(raw, '=')
	if eq < 0 {
		return parsedField{}, fmt.Errorf("field %q must be in key=value format", raw)
	}
	key := raw[:eq]
	val := raw[eq+1:]

	if key == "" {
		return parsedField{}, fmt.Errorf("field key cannot be empty in %q", raw)
	}

	// Type detection a la gh api -F
	switch {
	case val == "true":
		return parsedField{Key: key, Value: true}, nil
	case val == "false":
		return parsedField{Key: key, Value: false}, nil
	case val == "null":
		return parsedField{Key: key, Value: nil}, nil
	case strings.HasPrefix(val, "@"):
		content, err := os.ReadFile(val[1:]) // #nosec G304 -- user-specified file via -F key=@file flag
		if err != nil {
			return parsedField{}, fmt.Errorf("reading field file %s: %w", val[1:], err)
		}
		return parsedField{Key: key, Value: strings.TrimRight(string(content), "\r\n")}, nil
	default:
		if n, err := strconv.Atoi(val); err == nil {
			return parsedField{Key: key, Value: n}, nil
		}
		return parsedField{Key: key, Value: val}, nil
	}
}

// isPlatformEndpoint returns true if the endpoint looks like a Platform API path.
func isPlatformEndpoint(endpoint string) bool {
	normalized := endpoint
	if strings.HasPrefix(normalized, "http://") || strings.HasPrefix(normalized, "https://") {
		if u, err := url.Parse(normalized); err == nil {
			normalized = u.Path
		}
	}
	if !strings.HasPrefix(normalized, "/") {
		normalized = "/" + normalized
	}
	return strings.HasPrefix(normalized, "/v1/platform/") || normalized == "/v1/platform"
}

func runAPI(cmd *cobra.Command, args []string) error {
	endpoint := args[0]

	// Resolve auth: use platform key for /v1/platform/* endpoints or --platform flag
	profileName := GetProfile()
	usePlatform := apiPlatform || isPlatformEndpoint(endpoint)

	var apiKey string
	if usePlatform {
		apiKey = config.GetPlatformAPIKey(profileName)
		if apiKey == "" {
			return fmt.Errorf("platform API key not configured. Set CLERK_PLATFORM_KEY or run: clerk config set clerk.platform.key <ak_...>")
		}
	} else {
		useDotEnv := shouldUseDotEnvQuiet(profileName)
		apiKey = config.GetAPIKeyWithDotEnv(profileName, useDotEnv)
		if apiKey == "" {
			return fmt.Errorf("API key not configured. Run 'clerk init' or set CLERK_SECRET_KEY")
		}
	}
	baseURL := strings.TrimSuffix(config.GetAPIURL(profileName), "/")

	// Parse fields
	fields, err := parseFields(apiFields)
	if err != nil {
		return err
	}

	// Determine HTTP method
	method := resolveMethod(apiMethod, fields, apiInput)

	// Build the full URL
	reqURL, err := buildURL(endpoint, baseURL)
	if err != nil {
		return err
	}

	// Read body from --input if specified
	var inputBody []byte
	if apiInput != "" {
		inputBody, err = readInput(apiInput)
		if err != nil {
			return err
		}
	}

	// Validate flag combos
	if apiSlurp && !apiPaginate {
		return fmt.Errorf("--slurp requires --paginate")
	}

	httpClient := &http.Client{}
	var allPages []json.RawMessage

	for page := 0; ; page++ {
		var body io.Reader
		fieldsAsQuery := method == "GET" || apiInput != ""

		if fieldsAsQuery {
			reqURL = appendQueryFields(reqURL, fields)
		} else if len(fields) > 0 {
			bodyMap := make(map[string]interface{}, len(fields))
			for _, f := range fields {
				bodyMap[f.Key] = f.Value
			}
			bodyBytes, err := json.Marshal(bodyMap)
			if err != nil {
				return fmt.Errorf("marshaling body: %w", err)
			}
			body = bytes.NewReader(bodyBytes)
		}

		if inputBody != nil {
			body = bytes.NewReader(inputBody)
		}

		req, err := http.NewRequest(method, reqURL, body)
		if err != nil {
			return fmt.Errorf("creating request: %w", err)
		}

		// Standard headers
		req.Header.Set("Authorization", "Bearer "+apiKey)
		req.Header.Set("User-Agent", "clerk-cli/"+api.Version)
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		req.Header.Set("Accept", "application/json")

		// Custom headers
		for _, h := range apiHeaders {
			k, v, ok := parseHeader(h)
			if !ok {
				return fmt.Errorf("header %q must be in key:value format", h)
			}
			req.Header.Set(k, v)
		}

		if apiVerbose {
			printRequestHeaders(req)
		}

		resp, err := httpClient.Do(req)
		if err != nil {
			return fmt.Errorf("request failed: %w", err)
		}

		respBody, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			return fmt.Errorf("reading response: %w", err)
		}

		if apiVerbose {
			printResponseHeaders(resp)
		}

		if resp.StatusCode >= 400 {
			if !apiSilent {
				prettyPrintJSON(os.Stderr, respBody)
			}
			// Use the status code as exit code (matching gh api behavior)
			return fmt.Errorf("HTTP %d", resp.StatusCode)
		}

		if apiPaginate && apiSlurp {
			// Accumulate array elements for later output
			var arr []json.RawMessage
			if err := json.Unmarshal(respBody, &arr); err == nil {
				allPages = append(allPages, arr...)
			} else {
				// Not an array, just accumulate the whole thing
				allPages = append(allPages, respBody)
			}
		} else if !apiSilent {
			if err := outputResponse(respBody); err != nil {
				return err
			}
		}

		if !apiPaginate {
			break
		}

		nextURL := parseLinkNext(resp.Header.Get("Link"))
		if nextURL == "" {
			break
		}
		reqURL = nextURL
		// Only apply fields as query params on the first request,
		// subsequent pages use the URL from the Link header
		fields = nil
		inputBody = nil
	}

	if apiPaginate && apiSlurp && !apiSilent {
		slurped, err := json.Marshal(allPages)
		if err != nil {
			return fmt.Errorf("marshaling slurped results: %w", err)
		}
		return outputResponse(slurped)
	}

	return nil
}

func parseFields(raw []string) ([]parsedField, error) {
	fields := make([]parsedField, 0, len(raw))
	for _, r := range raw {
		f, err := parseFieldValue(r)
		if err != nil {
			return nil, err
		}
		fields = append(fields, f)
	}
	return fields, nil
}

func resolveMethod(explicit string, fields []parsedField, input string) string {
	if explicit != "" {
		return strings.ToUpper(explicit)
	}
	if len(fields) > 0 || input != "" {
		return "POST"
	}
	return "GET"
}

func buildURL(endpoint, baseURL string) (string, error) {
	// If endpoint is already an absolute URL, use it directly
	if strings.HasPrefix(endpoint, "http://") || strings.HasPrefix(endpoint, "https://") {
		return endpoint, nil
	}
	// Ensure leading slash
	if !strings.HasPrefix(endpoint, "/") {
		endpoint = "/" + endpoint
	}
	return baseURL + endpoint, nil
}

func appendQueryFields(rawURL string, fields []parsedField) string {
	if len(fields) == 0 {
		return rawURL
	}
	u, err := url.Parse(rawURL)
	if err != nil {
		return rawURL
	}
	q := u.Query()
	for _, f := range fields {
		q.Set(f.Key, fmt.Sprintf("%v", f.Value))
	}
	u.RawQuery = q.Encode()
	return u.String()
}

func readInput(path string) ([]byte, error) {
	if path == "-" {
		return io.ReadAll(os.Stdin)
	}
	return os.ReadFile(path) // #nosec G304 -- user-specified file via --input flag
}

func parseHeader(h string) (key, value string, ok bool) {
	idx := strings.IndexByte(h, ':')
	if idx < 0 {
		return "", "", false
	}
	return strings.TrimSpace(h[:idx]), strings.TrimSpace(h[idx+1:]), true
}

func printRequestHeaders(req *http.Request) {
	fmt.Fprintf(os.Stderr, "%s %s %s\n", output.Green(req.Method), req.URL.RequestURI(), output.Dim(req.Proto))
	fmt.Fprintf(os.Stderr, "%s %s\n", output.Dim("Host:"), req.URL.Host)
	for key, vals := range req.Header {
		for _, v := range vals {
			displayVal := v
			if strings.EqualFold(key, "Authorization") {
				// Mask the key, show only prefix
				if len(v) > 12 {
					displayVal = v[:12] + "..."
				}
			}
			fmt.Fprintf(os.Stderr, "%s %s\n", output.Dim(key+":"), displayVal)
		}
	}
	fmt.Fprintln(os.Stderr)
}

func printResponseHeaders(resp *http.Response) {
	fmt.Fprintf(os.Stderr, "%s %s\n", output.Dim(resp.Proto), colorizeStatus(resp.StatusCode, resp.Status))
	for key, vals := range resp.Header {
		for _, v := range vals {
			fmt.Fprintf(os.Stderr, "%s %s\n", output.Dim(key+":"), v)
		}
	}
	fmt.Fprintln(os.Stderr)
}

func colorizeStatus(code int, status string) string {
	switch {
	case code >= 200 && code < 300:
		return output.Green(status)
	case code >= 300 && code < 400:
		return output.Yellow(status)
	default:
		return output.Red(status)
	}
}

func outputResponse(data []byte) error {
	if apiJQ != "" {
		return applyJQ(data, apiJQ)
	}
	if apiTmpl != "" {
		return applyTemplate(data, apiTmpl)
	}
	prettyPrintJSON(os.Stdout, data)
	return nil
}

func prettyPrintJSON(w io.Writer, data []byte) {
	var buf bytes.Buffer
	if json.Indent(&buf, data, "", "  ") == nil {
		buf.WriteByte('\n')
		buf.WriteTo(w) //nolint:errcheck // best-effort write to stdout/stderr
	} else {
		// Not JSON, print raw
		fmt.Fprintln(w, string(data))
	}
}

func applyJQ(data []byte, expr string) error {
	query, err := gojq.Parse(expr)
	if err != nil {
		return fmt.Errorf("invalid jq expression: %w", err)
	}

	var input interface{}
	if err := json.Unmarshal(data, &input); err != nil {
		return fmt.Errorf("response is not valid JSON: %w", err)
	}

	iter := query.Run(input)
	for {
		v, ok := iter.Next()
		if !ok {
			break
		}
		if err, isErr := v.(error); isErr {
			return fmt.Errorf("jq: %w", err)
		}
		switch val := v.(type) {
		case string:
			fmt.Println(val)
		default:
			out, err := json.MarshalIndent(v, "", "  ")
			if err != nil {
				return fmt.Errorf("marshaling jq result: %w", err)
			}
			fmt.Println(string(out))
		}
	}
	return nil
}

func applyTemplate(data []byte, tmplStr string) error {
	tmpl, err := template.New("").Parse(tmplStr)
	if err != nil {
		return fmt.Errorf("invalid template: %w", err)
	}

	var input interface{}
	if err := json.Unmarshal(data, &input); err != nil {
		return fmt.Errorf("response is not valid JSON: %w", err)
	}

	return tmpl.Execute(os.Stdout, input)
}

// parseLinkNext extracts the URL for rel="next" from a Link header.
var linkNextRe = regexp.MustCompile(`<([^>]+)>;\s*rel="next"`)

func parseLinkNext(header string) string {
	m := linkNextRe.FindStringSubmatch(header)
	if len(m) < 2 {
		return ""
	}
	return m[1]
}
