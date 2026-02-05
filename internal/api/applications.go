package api

import (
	"encoding/json"
	"fmt"
	"strconv"
)

// Application represents a Clerk application in a workspace.
type Application struct {
	ID        string                `json:"application_id"`
	Name      string                `json:"name,omitempty"`
	LogoURL   string                `json:"logo_url,omitempty"`
	HomeURL   string                `json:"home_url,omitempty"`
	Instances []ApplicationInstance `json:"instances,omitempty"`
	CreatedAt int64                 `json:"created_at,omitempty"`
	UpdatedAt int64                 `json:"updated_at,omitempty"`
}

// ApplicationInstance represents an instance (environment) of an application.
type ApplicationInstance struct {
	ID              string `json:"instance_id"`
	ApplicationID   string `json:"application_id,omitempty"`
	EnvironmentType string `json:"environment_type"`
	PublishableKey  string `json:"publishable_key,omitempty"`
	SecretKey       string `json:"secret_key,omitempty"`
	Active          bool   `json:"active,omitempty"`
	CreatedAt       int64  `json:"created_at,omitempty"`
	UpdatedAt       int64  `json:"updated_at,omitempty"`
}

// ApplicationsAPI provides methods for managing applications via the Platform API.
type ApplicationsAPI struct {
	client *PlatformClient
}

// NewApplicationsAPI creates a new ApplicationsAPI.
func NewApplicationsAPI(client *PlatformClient) *ApplicationsAPI {
	return &ApplicationsAPI{client: client}
}

// ListApplicationsParams contains parameters for listing applications.
type ListApplicationsParams struct {
	Limit  int
	Offset int
	Query  string
}

// List returns a list of applications.
func (a *ApplicationsAPI) List(params ListApplicationsParams) ([]Application, int, error) {
	query := make(map[string]string)
	if params.Limit > 0 {
		query["limit"] = strconv.Itoa(params.Limit)
	}
	if params.Offset > 0 {
		query["offset"] = strconv.Itoa(params.Offset)
	}
	if params.Query != "" {
		query["query"] = params.Query
	}

	data, err := a.client.Get("/applications", query)
	if err != nil {
		return nil, 0, err
	}

	var apps []Application
	if err := json.Unmarshal(data, &apps); err != nil {
		return nil, 0, fmt.Errorf("failed to parse response: %w", err)
	}

	return apps, len(apps), nil
}

// Get returns a single application by ID.
func (a *ApplicationsAPI) Get(id string) (*Application, error) {
	data, err := a.client.Get(fmt.Sprintf("/applications/%s", id), nil)
	if err != nil {
		return nil, err
	}
	return ParseResponse[*Application](data)
}

// CreateApplicationParams contains parameters for creating an application.
type CreateApplicationParams struct {
	Name             string   `json:"name"`
	LogoURL          string   `json:"logo_url,omitempty"`
	HomeURL          string   `json:"home_url,omitempty"`
	EnvironmentTypes []string `json:"environment_types,omitempty"`
	Domain           string   `json:"domain,omitempty"`
}

// Create creates a new application.
func (a *ApplicationsAPI) Create(params CreateApplicationParams) (*Application, error) {
	data, err := a.client.Post("/applications", params)
	if err != nil {
		return nil, err
	}
	return ParseResponse[*Application](data)
}

// UpdateApplicationParams contains parameters for updating an application.
type UpdateApplicationParams struct {
	Name    string `json:"name,omitempty"`
	LogoURL string `json:"logo_url,omitempty"`
	HomeURL string `json:"home_url,omitempty"`
}

// Update updates an existing application.
func (a *ApplicationsAPI) Update(id string, params UpdateApplicationParams) (*Application, error) {
	data, err := a.client.Patch(fmt.Sprintf("/applications/%s", id), params)
	if err != nil {
		return nil, err
	}
	return ParseResponse[*Application](data)
}

// Delete deletes an application.
func (a *ApplicationsAPI) Delete(id string) error {
	_, err := a.client.Delete(fmt.Sprintf("/applications/%s", id))
	return err
}

// ListInstancesParams contains parameters for listing application instances.
type ListInstancesParams struct {
	IncludeSecretKeys bool
}

// ListInstances returns a list of instances for an application.
// It fetches all applications and filters to the specified app ID.
func (a *ApplicationsAPI) ListInstances(appID string, params ListInstancesParams) ([]ApplicationInstance, int, error) {
	query := make(map[string]string)
	if params.IncludeSecretKeys {
		query["include_secret_keys"] = "true"
	}

	data, err := a.client.Get("/applications", query)
	if err != nil {
		return nil, 0, err
	}

	var apps []Application
	if err := json.Unmarshal(data, &apps); err != nil {
		return nil, 0, fmt.Errorf("failed to parse response: %w", err)
	}

	// Find the matching application
	for _, app := range apps {
		if app.ID == appID {
			return app.Instances, len(app.Instances), nil
		}
	}

	return nil, 0, fmt.Errorf("application not found: %s", appID)
}
