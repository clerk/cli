package api

import (
	"fmt"
)

type Domain struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	IsSatellite   bool   `json:"is_satellite"`
	FrontendAPI   string `json:"frontend_api_url,omitempty"`
	AccountsURL   string `json:"accounts_portal_url,omitempty"`
	ProxyURL      string `json:"proxy_url,omitempty"`
	CNAMETargets  []CNAMETarget `json:"cname_targets,omitempty"`
	DevelopmentOrigin string `json:"development_origin"`
	CreatedAt     int64  `json:"created_at"`
	UpdatedAt     int64  `json:"updated_at"`
}

type CNAMETarget struct {
	Host  string `json:"host"`
	Value string `json:"value"`
}

type DomainsAPI struct {
	client *Client
}

func NewDomainsAPI(client *Client) *DomainsAPI {
	return &DomainsAPI{client: client}
}

func (a *DomainsAPI) List() ([]Domain, int, error) {
	data, err := a.client.Get("/v1/domains", nil)
	if err != nil {
		return nil, 0, err
	}

	result, err := ParseListResponse[Domain](data)
	if err != nil {
		return nil, 0, err
	}

	return result.Data, result.TotalCount, nil
}

func (a *DomainsAPI) Get(id string) (*Domain, error) {
	data, err := a.client.Get(fmt.Sprintf("/v1/domains/%s", id), nil)
	if err != nil {
		return nil, err
	}
	return ParseResponse[*Domain](data)
}

type AddDomainParams struct {
	Name        string `json:"name"`
	IsSatellite bool   `json:"is_satellite"`
	ProxyURL    string `json:"proxy_url,omitempty"`
}

func (a *DomainsAPI) Add(params AddDomainParams) (*Domain, error) {
	data, err := a.client.Post("/v1/domains", params)
	if err != nil {
		return nil, err
	}
	return ParseResponse[*Domain](data)
}

type UpdateDomainParams struct {
	Name     string `json:"name,omitempty"`
	ProxyURL string `json:"proxy_url,omitempty"`
}

func (a *DomainsAPI) Update(id string, params UpdateDomainParams) (*Domain, error) {
	data, err := a.client.Patch(fmt.Sprintf("/v1/domains/%s", id), params)
	if err != nil {
		return nil, err
	}
	return ParseResponse[*Domain](data)
}

func (a *DomainsAPI) Delete(id string) error {
	_, err := a.client.Delete(fmt.Sprintf("/v1/domains/%s", id))
	return err
}
