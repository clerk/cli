package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"math/rand"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"clerk.com/cli/internal/config"
	"clerk.com/cli/internal/output"
)

// PlatformClient is an HTTP client for the Clerk Platform API.
// It uses ak_* API keys for workspace-level operations.
type PlatformClient struct {
	baseURL    string
	apiKey     string
	httpClient *http.Client
	debug      bool
	ctx        context.Context
}

// PlatformClientOptions configures a PlatformClient.
type PlatformClientOptions struct {
	Profile string
	APIKey  string
	APIURL  string
	Debug   bool
	Context context.Context
}

// NewPlatformClient creates a new Platform API client.
func NewPlatformClient(opts PlatformClientOptions) *PlatformClient {
	profileName := config.GetActiveProfileName(opts.Profile)

	apiKey := opts.APIKey
	if apiKey == "" {
		apiKey = config.GetPlatformAPIKey(profileName)
	}

	apiURL := opts.APIURL
	if apiURL == "" {
		apiURL = config.GetPlatformAPIURL(profileName)
	}

	debug := opts.Debug || config.IsDebugEnabled()
	ctx := opts.Context
	if ctx == nil {
		ctx = context.Background()
	}

	return &PlatformClient{
		baseURL:    strings.TrimSuffix(apiURL, "/"),
		apiKey:     apiKey,
		httpClient: &http.Client{Timeout: 30 * time.Second},
		debug:      debug,
		ctx:        ctx,
	}
}

// Context returns the request context configured for this client.
func (c *PlatformClient) Context() context.Context {
	if c.ctx == nil {
		return context.Background()
	}
	return c.ctx
}

// Request performs an HTTP request to the Platform API.
func (c *PlatformClient) Request(method, path string, opts *RequestOptions) ([]byte, error) {
	data, _, err := c.RequestWithMeta(method, path, opts)
	return data, err
}

// RequestWithMeta performs an HTTP request and returns response metadata.
func (c *PlatformClient) RequestWithMeta(method, path string, opts *RequestOptions) ([]byte, *ResponseMeta, error) {
	if opts == nil {
		opts = &RequestOptions{}
	}

	fullURL := c.baseURL + path

	if len(opts.Query) > 0 {
		params := url.Values{}
		for k, v := range opts.Query {
			if v != "" {
				params.Set(k, v)
			}
		}
		if encoded := params.Encode(); encoded != "" {
			fullURL += "?" + encoded
		}
	}

	var bodyReader io.Reader
	if opts.Body != nil {
		bodyBytes, err := json.Marshal(opts.Body)
		if err != nil {
			return nil, nil, fmt.Errorf("failed to marshal request body: %w", err)
		}
		bodyReader = bytes.NewReader(bodyBytes)
	}

	var lastErr error
	for attempt := 0; attempt <= MaxRetries; attempt++ {
		if attempt > 0 {
			delay := c.calculateDelay(attempt, nil)
			time.Sleep(delay)
		}

		req, err := http.NewRequestWithContext(c.Context(), method, fullURL, bodyReader)
		if err != nil {
			return nil, nil, fmt.Errorf("failed to create request: %w", err)
		}

		req.Header.Set("Authorization", "Bearer "+c.apiKey)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json")
		req.Header.Set("User-Agent", "clerk-cli/"+Version)

		if opts.IfMatch != "" {
			req.Header.Set("If-Match", opts.IfMatch)
		}

		if c.debug {
			fmt.Fprintf(os.Stderr, "[DEBUG] --> %s %s\n", method, fullURL)
		}

		resp, err := c.httpClient.Do(req)
		if err != nil {
			lastErr = err
			if c.debug {
				fmt.Fprintf(os.Stderr, "[DEBUG] Request failed: %v\n", err)
			}
			continue
		}

		respBody, err := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		if err != nil {
			lastErr = err
			continue
		}

		if c.debug {
			fmt.Fprintf(os.Stderr, "[DEBUG] <-- %s %s (%d)\n", method, fullURL, resp.StatusCode)
			if len(respBody) > 0 && len(respBody) < 2000 {
				fmt.Fprintf(os.Stderr, "[DEBUG]     Body: %s\n", string(respBody))
			}
		}

		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			meta := &ResponseMeta{
				ETag: resp.Header.Get("ETag"),
			}
			return respBody, meta, nil
		}

		if c.shouldRetry(resp.StatusCode) && attempt < MaxRetries {
			lastErr = c.parseAPIError(resp.StatusCode, respBody)
			continue
		}

		return nil, nil, c.parseAPIError(resp.StatusCode, respBody)
	}

	return nil, nil, fmt.Errorf("request failed after %d retries: %w", MaxRetries, lastErr)
}

func (c *PlatformClient) shouldRetry(statusCode int) bool {
	switch statusCode {
	case 429, 408, 502, 503, 504:
		return true
	default:
		return statusCode >= 500
	}
}

func (c *PlatformClient) calculateDelay(attempt int, resp *http.Response) time.Duration {
	if resp != nil {
		if retryAfter := resp.Header.Get("Retry-After"); retryAfter != "" {
			if seconds, err := strconv.Atoi(retryAfter); err == nil {
				return time.Duration(seconds) * time.Second
			}
		}
	}

	delay := float64(BaseDelayMs) * math.Pow(2, float64(attempt-1))
	jitter := rand.Float64() * 0.3 * delay // #nosec G404 -- math/rand is fine for jitter, not crypto
	delay += jitter

	if delay > MaxDelayMs {
		delay = MaxDelayMs
	}

	return time.Duration(delay) * time.Millisecond
}

func (c *PlatformClient) parseAPIError(statusCode int, body []byte) error {
	var apiResp struct {
		Errors []struct {
			Code        string `json:"code"`
			Message     string `json:"message"`
			LongMessage string `json:"long_message"`
		} `json:"errors"`
	}

	if err := json.Unmarshal(body, &apiResp); err == nil && len(apiResp.Errors) > 0 {
		e := apiResp.Errors[0]
		return output.NewAPIError(statusCode, e.Code, e.Message, e.LongMessage)
	}

	return output.NewAPIError(statusCode, "", fmt.Sprintf("HTTP %d error", statusCode), string(body))
}

// Get performs a GET request.
func (c *PlatformClient) Get(path string, query map[string]string) ([]byte, error) {
	return c.Request("GET", path, &RequestOptions{Query: query})
}

// Post performs a POST request.
func (c *PlatformClient) Post(path string, body any) ([]byte, error) {
	return c.Request("POST", path, &RequestOptions{Body: body})
}

// Patch performs a PATCH request.
func (c *PlatformClient) Patch(path string, body any) ([]byte, error) {
	return c.Request("PATCH", path, &RequestOptions{Body: body})
}

// Delete performs a DELETE request.
func (c *PlatformClient) Delete(path string) ([]byte, error) {
	return c.Request("DELETE", path, nil)
}
