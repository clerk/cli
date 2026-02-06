package api

import (
	clerk "github.com/clerk/clerk-sdk-go/v2"
	sdkapikey "github.com/clerk/clerk-sdk-go/v2/apikey"
)

type APIKeysAPI struct {
	client    *Client
	sdkClient *sdkapikey.Client
}

func NewAPIKeysAPI(client *Client) *APIKeysAPI {
	return &APIKeysAPI{
		client:    client,
		sdkClient: sdkapikey.NewClient(client.SDKConfig()),
	}
}

func (a *APIKeysAPI) List() (*clerk.APIKeyList, error) {
	return a.sdkClient.List(a.client.Context(), &sdkapikey.ListParams{})
}

func (a *APIKeysAPI) Get(id string) (*clerk.APIKey, error) {
	return a.sdkClient.Get(a.client.Context(), id)
}

func (a *APIKeysAPI) Create(params sdkapikey.CreateParams) (*clerk.APIKeyWithSecret, error) {
	return a.sdkClient.Create(a.client.Context(), &params)
}

func (a *APIKeysAPI) Revoke(id string) error {
	_, err := a.sdkClient.Delete(a.client.Context(), id)
	return err
}
