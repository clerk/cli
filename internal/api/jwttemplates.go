package api

import (
	clerk "github.com/clerk/clerk-sdk-go/v2"
	sdkjwt "github.com/clerk/clerk-sdk-go/v2/jwttemplate"
)

type JWTTemplatesAPI struct {
	client    *Client
	sdkClient *sdkjwt.Client
}

func NewJWTTemplatesAPI(client *Client) *JWTTemplatesAPI {
	return &JWTTemplatesAPI{
		client:    client,
		sdkClient: sdkjwt.NewClient(client.SDKConfig()),
	}
}

func (a *JWTTemplatesAPI) List() (*clerk.JWTTemplateList, error) {
	return a.sdkClient.List(a.client.Context(), &sdkjwt.ListParams{})
}

func (a *JWTTemplatesAPI) Get(id string) (*clerk.JWTTemplate, error) {
	return a.sdkClient.Get(a.client.Context(), id)
}

func (a *JWTTemplatesAPI) Create(params sdkjwt.CreateParams) (*clerk.JWTTemplate, error) {
	return a.sdkClient.Create(a.client.Context(), &params)
}

func (a *JWTTemplatesAPI) Update(id string, params sdkjwt.UpdateParams) (*clerk.JWTTemplate, error) {
	return a.sdkClient.Update(a.client.Context(), id, &params)
}

func (a *JWTTemplatesAPI) Delete(id string) error {
	_, err := a.sdkClient.Delete(a.client.Context(), id)
	return err
}
