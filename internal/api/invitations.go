package api

import (
	clerk "github.com/clerk/clerk-sdk-go/v2"
	sdkinvitation "github.com/clerk/clerk-sdk-go/v2/invitation"
)

type InvitationsAPI struct {
	client    *Client
	sdkClient *sdkinvitation.Client
}

func NewInvitationsAPI(client *Client) *InvitationsAPI {
	return &InvitationsAPI{
		client:    client,
		sdkClient: sdkinvitation.NewClient(client.SDKConfig()),
	}
}

func (a *InvitationsAPI) List(params sdkinvitation.ListParams) (*clerk.InvitationList, error) {
	return a.sdkClient.List(a.client.Context(), &params)
}

func (a *InvitationsAPI) Create(params sdkinvitation.CreateParams) (*clerk.Invitation, error) {
	return a.sdkClient.Create(a.client.Context(), &params)
}

func (a *InvitationsAPI) BulkCreate(params sdkinvitation.BulkCreateParams) ([]*clerk.Invitation, error) {
	result, err := a.sdkClient.BulkCreate(a.client.Context(), &params)
	if err != nil {
		return nil, err
	}
	return result.Invitations, nil
}

func (a *InvitationsAPI) Revoke(id string) (*clerk.Invitation, error) {
	return a.sdkClient.Revoke(a.client.Context(), id)
}
