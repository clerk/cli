package api

import (
	clerk "github.com/clerk/clerk-sdk-go/v2"
	sdkemail "github.com/clerk/clerk-sdk-go/v2/emailaddress"
)

type EmailsAPI struct {
	client    *Client
	sdkClient *sdkemail.Client
}

func NewEmailsAPI(client *Client) *EmailsAPI {
	return &EmailsAPI{
		client:    client,
		sdkClient: sdkemail.NewClient(client.SDKConfig()),
	}
}

func (a *EmailsAPI) Get(id string) (*clerk.EmailAddress, error) {
	return a.sdkClient.Get(a.client.Context(), id)
}

func (a *EmailsAPI) Create(params sdkemail.CreateParams) (*clerk.EmailAddress, error) {
	return a.sdkClient.Create(a.client.Context(), &params)
}

func (a *EmailsAPI) Update(id string, params sdkemail.UpdateParams) (*clerk.EmailAddress, error) {
	return a.sdkClient.Update(a.client.Context(), id, &params)
}

func (a *EmailsAPI) Delete(id string) error {
	_, err := a.sdkClient.Delete(a.client.Context(), id)
	return err
}
