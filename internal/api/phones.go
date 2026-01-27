package api

import (
	"fmt"
)

type PhoneNumberDetails struct {
	ID          string `json:"id"`
	PhoneNumber string `json:"phone_number"`
	Verified    bool   `json:"verified"`
	Primary     bool   `json:"primary,omitempty"`
	CreatedAt   int64  `json:"created_at"`
	UpdatedAt   int64  `json:"updated_at"`
}

type PhonesAPI struct {
	client *Client
}

func NewPhonesAPI(client *Client) *PhonesAPI {
	return &PhonesAPI{client: client}
}

func (a *PhonesAPI) Get(id string) (*PhoneNumberDetails, error) {
	data, err := a.client.Get(fmt.Sprintf("/v1/phone_numbers/%s", id), nil)
	if err != nil {
		return nil, err
	}
	return ParseResponse[*PhoneNumberDetails](data)
}

type CreatePhoneParams struct {
	UserID      string `json:"user_id"`
	PhoneNumber string `json:"phone_number"`
	Verified    bool   `json:"verified,omitempty"`
	Primary     bool   `json:"primary,omitempty"`
}

func (a *PhonesAPI) Create(params CreatePhoneParams) (*PhoneNumberDetails, error) {
	data, err := a.client.Post("/v1/phone_numbers", params)
	if err != nil {
		return nil, err
	}
	return ParseResponse[*PhoneNumberDetails](data)
}

type UpdatePhoneParams struct {
	Verified bool `json:"verified,omitempty"`
	Primary  bool `json:"primary,omitempty"`
}

func (a *PhonesAPI) Update(id string, params UpdatePhoneParams) (*PhoneNumberDetails, error) {
	data, err := a.client.Patch(fmt.Sprintf("/v1/phone_numbers/%s", id), params)
	if err != nil {
		return nil, err
	}
	return ParseResponse[*PhoneNumberDetails](data)
}

func (a *PhonesAPI) Delete(id string) error {
	_, err := a.client.Delete(fmt.Sprintf("/v1/phone_numbers/%s", id))
	return err
}
