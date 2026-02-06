package api

import (
	clerk "github.com/clerk/clerk-sdk-go/v2"
	sdkinstance "github.com/clerk/clerk-sdk-go/v2/instancesettings"
)

type Instance struct {
	Object            string   `json:"object"`
	ID                string   `json:"id"`
	EnvironmentType   string   `json:"environment_type"`
	AllowedOrigins    []string `json:"allowed_origins,omitempty"`
	HomeOrigin        string   `json:"home_origin,omitempty"`
	SupportEmail      string   `json:"support_email,omitempty"`
	ClerkJSVersion    string   `json:"clerk_js_version,omitempty"`
	DevelopmentOrigin string   `json:"development_origin,omitempty"`
	MaintenanceMode   bool     `json:"maintenance_mode"`
}

type InstanceAPI struct {
	client    *Client
	sdkClient *sdkinstance.Client
}

func NewInstanceAPI(client *Client) *InstanceAPI {
	return &InstanceAPI{
		client:    client,
		sdkClient: sdkinstance.NewClient(client.SDKConfig()),
	}
}

// Get retrieves instance settings. No SDK equivalent exists, so we use the raw client.
func (a *InstanceAPI) Get() (*Instance, error) {
	data, err := a.client.Get("/v1/instance", nil)
	if err != nil {
		return nil, err
	}
	return ParseResponse[*Instance](data)
}

func (a *InstanceAPI) Update(params sdkinstance.UpdateParams) error {
	return a.sdkClient.Update(a.client.Context(), &params)
}

func (a *InstanceAPI) UpdateRestrictions(params sdkinstance.UpdateRestrictionsParams) (*clerk.InstanceRestrictions, error) {
	return a.sdkClient.UpdateRestrictions(a.client.Context(), &params)
}
