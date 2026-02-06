package api

import (
	clerk "github.com/clerk/clerk-sdk-go/v2"
	sdksession "github.com/clerk/clerk-sdk-go/v2/session"
)

type SessionsAPI struct {
	client    *Client
	sdkClient *sdksession.Client
}

func NewSessionsAPI(client *Client) *SessionsAPI {
	return &SessionsAPI{
		client:    client,
		sdkClient: sdksession.NewClient(client.SDKConfig()),
	}
}

func (a *SessionsAPI) List(params sdksession.ListParams) (*clerk.SessionList, error) {
	return a.sdkClient.List(a.client.Context(), &params)
}

func (a *SessionsAPI) Get(id string) (*clerk.Session, error) {
	return a.sdkClient.Get(a.client.Context(), id)
}

func (a *SessionsAPI) Revoke(id string) (*clerk.Session, error) {
	return a.sdkClient.Revoke(a.client.Context(), &sdksession.RevokeParams{ID: id})
}
