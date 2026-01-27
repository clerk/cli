package api

import (
	"fmt"
)

type BlocklistIdentifier struct {
	ID             string `json:"id"`
	Identifier     string `json:"identifier"`
	IdentifierType string `json:"identifier_type"`
	CreatedAt      int64  `json:"created_at"`
	UpdatedAt      int64  `json:"updated_at"`
}

type BlocklistAPI struct {
	client *Client
}

func NewBlocklistAPI(client *Client) *BlocklistAPI {
	return &BlocklistAPI{client: client}
}

func (a *BlocklistAPI) List() ([]BlocklistIdentifier, error) {
	data, err := a.client.Get("/v1/blocklist_identifiers", nil)
	if err != nil {
		return nil, err
	}

	result, err := ParseListResponse[BlocklistIdentifier](data)
	if err != nil {
		return nil, err
	}

	return result.Data, nil
}

type AddBlocklistParams struct {
	Identifier string `json:"identifier"`
}

func (a *BlocklistAPI) Add(params AddBlocklistParams) (*BlocklistIdentifier, error) {
	data, err := a.client.Post("/v1/blocklist_identifiers", params)
	if err != nil {
		return nil, err
	}
	return ParseResponse[*BlocklistIdentifier](data)
}

func (a *BlocklistAPI) Remove(id string) error {
	_, err := a.client.Delete(fmt.Sprintf("/v1/blocklist_identifiers/%s", id))
	return err
}
