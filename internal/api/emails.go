package api

import (
	"fmt"
)

type EmailAddressDetails struct {
	ID           string `json:"id"`
	EmailAddress string `json:"email_address"`
	Verified     bool   `json:"verified"`
	Primary      bool   `json:"primary,omitempty"`
	CreatedAt    int64  `json:"created_at"`
	UpdatedAt    int64  `json:"updated_at"`
}

type EmailsAPI struct {
	client *Client
}

func NewEmailsAPI(client *Client) *EmailsAPI {
	return &EmailsAPI{client: client}
}

func (a *EmailsAPI) Get(id string) (*EmailAddressDetails, error) {
	data, err := a.client.Get(fmt.Sprintf("/v1/email_addresses/%s", id), nil)
	if err != nil {
		return nil, err
	}
	return ParseResponse[*EmailAddressDetails](data)
}

type CreateEmailParams struct {
	UserID       string `json:"user_id"`
	EmailAddress string `json:"email_address"`
	Verified     bool   `json:"verified,omitempty"`
	Primary      bool   `json:"primary,omitempty"`
}

func (a *EmailsAPI) Create(params CreateEmailParams) (*EmailAddressDetails, error) {
	data, err := a.client.Post("/v1/email_addresses", params)
	if err != nil {
		return nil, err
	}
	return ParseResponse[*EmailAddressDetails](data)
}

type UpdateEmailParams struct {
	Verified bool `json:"verified,omitempty"`
	Primary  bool `json:"primary,omitempty"`
}

func (a *EmailsAPI) Update(id string, params UpdateEmailParams) (*EmailAddressDetails, error) {
	data, err := a.client.Patch(fmt.Sprintf("/v1/email_addresses/%s", id), params)
	if err != nil {
		return nil, err
	}
	return ParseResponse[*EmailAddressDetails](data)
}

func (a *EmailsAPI) Delete(id string) error {
	_, err := a.client.Delete(fmt.Sprintf("/v1/email_addresses/%s", id))
	return err
}
