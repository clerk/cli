package api

import (
	"fmt"
	"strings"
)

type RestrictionIdentifier struct {
	ID             string `json:"id"`
	Identifier     string `json:"identifier"`
	IdentifierType string `json:"identifier_type"`
	CreatedAt      int64  `json:"created_at"`
	UpdatedAt      int64  `json:"updated_at"`
}

type RestrictionsAPI struct {
	client *Client
}

func NewRestrictionsAPI(client *Client) *RestrictionsAPI {
	return &RestrictionsAPI{client: client}
}

func (a *RestrictionsAPI) ListAllowlist() ([]RestrictionIdentifier, error) {
	data, err := a.client.Get("/v1/allowlist_identifiers", nil)
	if err != nil {
		return nil, err
	}
	return ParseArrayResponse[RestrictionIdentifier](data)
}

func (a *RestrictionsAPI) ListBlocklist() ([]RestrictionIdentifier, error) {
	data, err := a.client.Get("/v1/blocklist_identifiers", nil)
	if err != nil {
		return nil, err
	}
	result, err := ParseListResponse[RestrictionIdentifier](data)
	if err != nil {
		return nil, err
	}
	return result.Data, nil
}

type AddRestrictionParams struct {
	Identifier string `json:"identifier"`
	Notify     bool   `json:"notify,omitempty"`
}

func (a *RestrictionsAPI) AddToAllowlist(params AddRestrictionParams) (*RestrictionIdentifier, error) {
	data, err := a.client.Post("/v1/allowlist_identifiers", params)
	if err != nil {
		return nil, err
	}
	return ParseResponse[*RestrictionIdentifier](data)
}

func (a *RestrictionsAPI) AddToBlocklist(identifier string) (*RestrictionIdentifier, error) {
	data, err := a.client.Post("/v1/blocklist_identifiers", map[string]string{
		"identifier": identifier,
	})
	if err != nil {
		return nil, err
	}
	return ParseResponse[*RestrictionIdentifier](data)
}

func (a *RestrictionsAPI) Remove(id string) error {
	endpoint := a.getEndpointForID(id)
	_, err := a.client.Delete(fmt.Sprintf("%s/%s", endpoint, id))
	return err
}

func (a *RestrictionsAPI) getEndpointForID(id string) string {
	if strings.HasPrefix(id, "blid_") {
		return "/v1/blocklist_identifiers"
	}
	return "/v1/allowlist_identifiers"
}
