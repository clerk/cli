package api

import (
	"fmt"
)

type APIKey struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Secret    string `json:"secret,omitempty"`
	Type      string `json:"type"`
	CreatedAt int64  `json:"created_at"`
	UpdatedAt int64  `json:"updated_at"`
}

type APIKeysAPI struct {
	client *Client
}

func NewAPIKeysAPI(client *Client) *APIKeysAPI {
	return &APIKeysAPI{client: client}
}

func (a *APIKeysAPI) List() ([]APIKey, error) {
	data, err := a.client.Get("/v1/api_keys", nil)
	if err != nil {
		return nil, err
	}

	return ParseArrayResponse[APIKey](data)
}

func (a *APIKeysAPI) Get(id string) (*APIKey, error) {
	data, err := a.client.Get(fmt.Sprintf("/v1/api_keys/%s", id), nil)
	if err != nil {
		return nil, err
	}
	return ParseResponse[*APIKey](data)
}

type CreateAPIKeyParams struct {
	Name string `json:"name"`
	Type string `json:"type,omitempty"`
}

func (a *APIKeysAPI) Create(params CreateAPIKeyParams) (*APIKey, error) {
	data, err := a.client.Post("/v1/api_keys", params)
	if err != nil {
		return nil, err
	}
	return ParseResponse[*APIKey](data)
}

func (a *APIKeysAPI) Revoke(id string) error {
	_, err := a.client.Delete(fmt.Sprintf("/v1/api_keys/%s", id))
	return err
}
