package api

import (
	"fmt"
	"strconv"
)

// Transfer represents an application transfer between workspaces.
type Transfer struct {
	ID              string `json:"id"`
	ApplicationID   string `json:"application_id"`
	SourceWorkspace string `json:"source_workspace"`
	TargetWorkspace string `json:"target_workspace"`
	Status          string `json:"status"`
	ExpiresAt       int64  `json:"expires_at,omitempty"`
	CreatedAt       int64  `json:"created_at"`
	UpdatedAt       int64  `json:"updated_at"`
}

// TransfersAPI provides methods for managing transfers via the Platform API.
type TransfersAPI struct {
	client *PlatformClient
}

// NewTransfersAPI creates a new TransfersAPI.
func NewTransfersAPI(client *PlatformClient) *TransfersAPI {
	return &TransfersAPI{client: client}
}

// ListTransfersParams contains parameters for listing transfers.
type ListTransfersParams struct {
	Limit  int
	Offset int
	Status string
}

// List returns a list of transfers.
func (a *TransfersAPI) List(params ListTransfersParams) ([]Transfer, int, error) {
	query := make(map[string]string)
	if params.Limit > 0 {
		query["limit"] = strconv.Itoa(params.Limit)
	}
	if params.Offset > 0 {
		query["offset"] = strconv.Itoa(params.Offset)
	}
	if params.Status != "" {
		query["status"] = params.Status
	}

	data, err := a.client.Get("/transfers", query)
	if err != nil {
		return nil, 0, err
	}

	resp, err := ParseListResponse[Transfer](data)
	if err != nil {
		return nil, 0, err
	}

	return resp.Data, resp.TotalCount, nil
}

// Get returns a single transfer by ID.
func (a *TransfersAPI) Get(id string) (*Transfer, error) {
	data, err := a.client.Get(fmt.Sprintf("/transfers/%s", id), nil)
	if err != nil {
		return nil, err
	}
	return ParseResponse[*Transfer](data)
}

// CreateTransferParams contains parameters for creating a transfer.
type CreateTransferParams struct {
	ApplicationID   string `json:"application_id"`
	TargetWorkspace string `json:"target_workspace"`
}

// Create creates a new transfer.
func (a *TransfersAPI) Create(params CreateTransferParams) (*Transfer, error) {
	data, err := a.client.Post("/transfers", params)
	if err != nil {
		return nil, err
	}
	return ParseResponse[*Transfer](data)
}

// Accept accepts a pending transfer.
func (a *TransfersAPI) Accept(id string) (*Transfer, error) {
	data, err := a.client.Post(fmt.Sprintf("/transfers/%s/accept", id), nil)
	if err != nil {
		return nil, err
	}
	return ParseResponse[*Transfer](data)
}

// Cancel cancels a pending transfer.
func (a *TransfersAPI) Cancel(id string) (*Transfer, error) {
	data, err := a.client.Post(fmt.Sprintf("/transfers/%s/cancel", id), nil)
	if err != nil {
		return nil, err
	}
	return ParseResponse[*Transfer](data)
}
