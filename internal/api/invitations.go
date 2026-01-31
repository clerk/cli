package api

import (
	"fmt"
	"strconv"
)

type Invitation struct {
	ID             string                 `json:"id"`
	EmailAddress   string                 `json:"email_address"`
	Status         string                 `json:"status"`
	URL            string                 `json:"url,omitempty"`
	PublicMetadata map[string]interface{} `json:"public_metadata,omitempty"`
	CreatedAt      int64                  `json:"created_at"`
	UpdatedAt      int64                  `json:"updated_at"`
}

type InvitationsAPI struct {
	client *Client
}

func NewInvitationsAPI(client *Client) *InvitationsAPI {
	return &InvitationsAPI{client: client}
}

type ListInvitationsParams struct {
	Status string
	Limit  int
	Offset int
}

func (a *InvitationsAPI) List(params ListInvitationsParams) ([]Invitation, int, error) {
	query := make(map[string]string)
	if params.Status != "" {
		query["status"] = params.Status
	}
	if params.Limit > 0 {
		query["limit"] = strconv.Itoa(params.Limit)
	}
	if params.Offset > 0 {
		query["offset"] = strconv.Itoa(params.Offset)
	}

	data, err := a.client.Get("/v1/invitations", query)
	if err != nil {
		return nil, 0, err
	}

	result, err := ParseArrayResponse[Invitation](data)
	if err != nil {
		return nil, 0, err
	}

	return result, len(result), nil
}

type CreateInvitationParams struct {
	EmailAddress   string                 `json:"email_address"`
	RedirectURL    string                 `json:"redirect_url,omitempty"`
	PublicMetadata map[string]interface{} `json:"public_metadata,omitempty"`
	Notify         bool                   `json:"notify,omitempty"`
	IgnoreExisting bool                   `json:"ignore_existing,omitempty"`
}

func (a *InvitationsAPI) Create(params CreateInvitationParams) (*Invitation, error) {
	data, err := a.client.Post("/v1/invitations", params)
	if err != nil {
		return nil, err
	}
	return ParseResponse[*Invitation](data)
}

type BulkCreateInvitationsParams struct {
	EmailAddresses []string `json:"email_addresses"`
	RedirectURL    string   `json:"redirect_url,omitempty"`
	Notify         bool     `json:"notify,omitempty"`
	IgnoreExisting bool     `json:"ignore_existing,omitempty"`
}

func (a *InvitationsAPI) BulkCreate(params BulkCreateInvitationsParams) ([]Invitation, error) {
	data, err := a.client.Post("/v1/invitations/bulk", params)
	if err != nil {
		return nil, err
	}

	return ParseArrayResponse[Invitation](data)
}

func (a *InvitationsAPI) Revoke(id string) (*Invitation, error) {
	data, err := a.client.Post(fmt.Sprintf("/v1/invitations/%s/revoke", id), nil)
	if err != nil {
		return nil, err
	}
	return ParseResponse[*Invitation](data)
}
