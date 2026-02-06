package api

import (
	clerk "github.com/clerk/clerk-sdk-go/v2"
	sdkdomain "github.com/clerk/clerk-sdk-go/v2/domain"
)

type DomainsAPI struct {
	client    *Client
	sdkClient *sdkdomain.Client
}

func NewDomainsAPI(client *Client) *DomainsAPI {
	return &DomainsAPI{
		client:    client,
		sdkClient: sdkdomain.NewClient(client.SDKConfig()),
	}
}

func (a *DomainsAPI) List() (*clerk.DomainList, error) {
	return a.sdkClient.List(a.client.Context(), &sdkdomain.ListParams{})
}

func (a *DomainsAPI) Get(id string) (*clerk.Domain, error) {
	// The SDK domain client doesn't have a Get method, so we use the raw client
	data, err := a.client.Get("/v1/domains/"+id, nil)
	if err != nil {
		return nil, err
	}
	return ParseResponse[*clerk.Domain](data)
}

func (a *DomainsAPI) Add(params sdkdomain.CreateParams) (*clerk.Domain, error) {
	return a.sdkClient.Create(a.client.Context(), &params)
}

func (a *DomainsAPI) Update(id string, params sdkdomain.UpdateParams) (*clerk.Domain, error) {
	return a.sdkClient.Update(a.client.Context(), id, &params)
}

func (a *DomainsAPI) Delete(id string) error {
	_, err := a.sdkClient.Delete(a.client.Context(), id)
	return err
}
