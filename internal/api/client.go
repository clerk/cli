package api

import (
	"bytes"
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

// Version is set at build time via ldflags.
var Version = "dev"

const (
	MaxRetries   = 3
	BaseDelayMs  = 1000
	MaxDelayMs   = 30000
)

type Client struct {
	baseURL    string
	apiKey     string
	httpClient *http.Client
	debug      bool
}

type ClientOptions struct {
	Profile string
	APIKey  string
	APIURL  string
	Debug   bool
}

func NewClient(opts ClientOptions) *Client {
	profileName := config.GetActiveProfileName(opts.Profile)

	apiKey := opts.APIKey
	if apiKey == "" {
		apiKey = config.GetAPIKey(profileName)
	}

	apiURL := opts.APIURL
	if apiURL == "" {
		apiURL = config.GetAPIURL(profileName)
	}

	debug := opts.Debug || config.IsDebugEnabled()

	return &Client{
		baseURL:    strings.TrimSuffix(apiURL, "/"),
		apiKey:     apiKey,
		httpClient: &http.Client{Timeout: 30 * time.Second},
		debug:      debug,
	}
}

type RequestOptions struct {
	Body    interface{}
	Query   map[string]string
	IfMatch string
}

type ResponseMeta struct {
	ETag string
}

func (c *Client) Request(method, path string, opts *RequestOptions) ([]byte, error) {
	data, _, err := c.RequestWithMeta(method, path, opts)
	return data, err
}

func (c *Client) RequestWithMeta(method, path string, opts *RequestOptions) ([]byte, *ResponseMeta, error) {
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

		req, err := http.NewRequest(method, fullURL, bodyReader)
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
		resp.Body.Close()
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

func (c *Client) shouldRetry(statusCode int) bool {
	switch statusCode {
	case 429, 408, 502, 503, 504:
		return true
	default:
		return statusCode >= 500
	}
}

func (c *Client) calculateDelay(attempt int, resp *http.Response) time.Duration {
	if resp != nil {
		if retryAfter := resp.Header.Get("Retry-After"); retryAfter != "" {
			if seconds, err := strconv.Atoi(retryAfter); err == nil {
				return time.Duration(seconds) * time.Second
			}
		}
	}

	delay := float64(BaseDelayMs) * math.Pow(2, float64(attempt-1))
	jitter := rand.Float64() * 0.3 * delay
	delay += jitter

	if delay > MaxDelayMs {
		delay = MaxDelayMs
	}

	return time.Duration(delay) * time.Millisecond
}

func (c *Client) parseAPIError(statusCode int, body []byte) error {
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

func (c *Client) Get(path string, query map[string]string) ([]byte, error) {
	return c.Request("GET", path, &RequestOptions{Query: query})
}

func (c *Client) Post(path string, body interface{}) ([]byte, error) {
	return c.Request("POST", path, &RequestOptions{Body: body})
}

func (c *Client) Patch(path string, body interface{}) ([]byte, error) {
	return c.Request("PATCH", path, &RequestOptions{Body: body})
}

func (c *Client) Put(path string, body interface{}) ([]byte, error) {
	return c.Request("PUT", path, &RequestOptions{Body: body})
}

func (c *Client) Delete(path string) ([]byte, error) {
	return c.Request("DELETE", path, nil)
}

func ParseResponse[T any](data []byte) (T, error) {
	var result T
	if err := json.Unmarshal(data, &result); err != nil {
		return result, fmt.Errorf("failed to parse response: %w", err)
	}
	return result, nil
}

type ListResponse[T any] struct {
	Data       []T `json:"data"`
	TotalCount int `json:"total_count"`
}

func ParseListResponse[T any](data []byte) (*ListResponse[T], error) {
	var result ListResponse[T]
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, fmt.Errorf("failed to parse response: %w", err)
	}
	return &result, nil
}

// ParseArrayResponse parses a JSON response that could be either a raw array
// or a wrapped {data: [], total_count: N} object, returning just the items.
func ParseArrayResponse[T any](data []byte) ([]T, error) {
	// Try plain array first
	var arr []T
	if err := json.Unmarshal(data, &arr); err == nil {
		return arr, nil
	}

	// Fall back to wrapped format
	var wrapped ListResponse[T]
	if err := json.Unmarshal(data, &wrapped); err != nil {
		return nil, fmt.Errorf("failed to parse response: %w", err)
	}
	return wrapped.Data, nil
}
