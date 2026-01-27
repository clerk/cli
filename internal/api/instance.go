package api

type Instance struct {
	Object                  string `json:"object"`
	ID                      string `json:"id"`
	EnvironmentType         string `json:"environment_type"`
	AllowedOrigins          []string `json:"allowed_origins,omitempty"`
	HomeOrigin              string `json:"home_origin,omitempty"`
	SupportEmail            string `json:"support_email,omitempty"`
	ClerkJSVersion          string `json:"clerk_js_version,omitempty"`
	DevelopmentOrigin       string `json:"development_origin,omitempty"`
	MaintenanceMode         bool   `json:"maintenance_mode"`
}

type InstanceRestrictions struct {
	Allowlist      bool `json:"allowlist"`
	Blocklist      bool `json:"blocklist"`
	BlockDisposable bool `json:"block_email_subaddresses"`
	BlockSubaddresses bool `json:"block_disposable_email_domains"`
}

type InstanceAPI struct {
	client *Client
}

func NewInstanceAPI(client *Client) *InstanceAPI {
	return &InstanceAPI{client: client}
}

func (a *InstanceAPI) Get() (*Instance, error) {
	data, err := a.client.Get("/v1/instance", nil)
	if err != nil {
		return nil, err
	}
	return ParseResponse[*Instance](data)
}

type UpdateInstanceParams struct {
	SupportEmail    string   `json:"support_email,omitempty"`
	ClerkJSVersion  string   `json:"clerk_js_version,omitempty"`
	AllowedOrigins  []string `json:"allowed_origins,omitempty"`
	MaintenanceMode *bool    `json:"maintenance_mode,omitempty"`
}

func (a *InstanceAPI) Update(params UpdateInstanceParams) (*Instance, error) {
	data, err := a.client.Patch("/v1/instance", params)
	if err != nil {
		return nil, err
	}
	return ParseResponse[*Instance](data)
}

type UpdateRestrictionsParams struct {
	Allowlist         *bool `json:"allowlist,omitempty"`
	Blocklist         *bool `json:"blocklist,omitempty"`
	BlockDisposable   *bool `json:"block_email_subaddresses,omitempty"`
	BlockSubaddresses *bool `json:"block_disposable_email_domains,omitempty"`
}

func (a *InstanceAPI) UpdateRestrictions(params UpdateRestrictionsParams) (*InstanceRestrictions, error) {
	data, err := a.client.Patch("/v1/instance/restrictions", params)
	if err != nil {
		return nil, err
	}
	return ParseResponse[*InstanceRestrictions](data)
}
