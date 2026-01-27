package api

import (
	"fmt"
)

type AllowlistIdentifier struct {
	ID           string `json:"id"`
	Identifier   string `json:"identifier"`
	IdentifierType string `json:"identifier_type"`
	CreatedAt    int64  `json:"created_at"`
	UpdatedAt    int64  `json:"updated_at"`
}

type AllowlistAPI struct {
	client *Client
}

func NewAllowlistAPI(client *Client) *AllowlistAPI {
	return &AllowlistAPI{client: client}
}

func (a *AllowlistAPI) List() ([]AllowlistIdentifier, error) {
	data, err := a.client.Get("/v1/allowlist_identifiers", nil)
	if err != nil {
		return nil, err
	}

	result, err := ParseListResponse[AllowlistIdentifier](data)
	if err != nil {
		return nil, err
	}

	return result.Data, nil
}

type AddAllowlistParams struct {
	Identifier string `json:"identifier"`
	Notify     bool   `json:"notify,omitempty"`
}

func (a *AllowlistAPI) Add(params AddAllowlistParams) (*AllowlistIdentifier, error) {
	data, err := a.client.Post("/v1/allowlist_identifiers", params)
	if err != nil {
		return nil, err
	}
	return ParseResponse[*AllowlistIdentifier](data)
}

func (a *AllowlistAPI) Remove(id string) error {
	_, err := a.client.Delete(fmt.Sprintf("/v1/allowlist_identifiers/%s", id))
	return err
}
