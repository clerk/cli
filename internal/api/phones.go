package api

import (
	clerk "github.com/clerk/clerk-sdk-go/v2"
	sdkphone "github.com/clerk/clerk-sdk-go/v2/phonenumber"
)

type PhonesAPI struct {
	client    *Client
	sdkClient *sdkphone.Client
}

func NewPhonesAPI(client *Client) *PhonesAPI {
	return &PhonesAPI{
		client:    client,
		sdkClient: sdkphone.NewClient(client.SDKConfig()),
	}
}

func (a *PhonesAPI) Get(id string) (*clerk.PhoneNumber, error) {
	return a.sdkClient.Get(a.client.Context(), id)
}

func (a *PhonesAPI) Create(params sdkphone.CreateParams) (*clerk.PhoneNumber, error) {
	return a.sdkClient.Create(a.client.Context(), &params)
}

func (a *PhonesAPI) Update(id string, params sdkphone.UpdateParams) (*clerk.PhoneNumber, error) {
	return a.sdkClient.Update(a.client.Context(), id, &params)
}

func (a *PhonesAPI) Delete(id string) error {
	_, err := a.sdkClient.Delete(a.client.Context(), id)
	return err
}
