package api

import (
	"fmt"
)

type JWTTemplate struct {
	ID               string                 `json:"id"`
	Name             string                 `json:"name"`
	Claims           map[string]interface{} `json:"claims"`
	Lifetime         int                    `json:"lifetime"`
	AllowedClockSkew int                    `json:"allowed_clock_skew"`
	CustomSigningKey bool                   `json:"custom_signing_key"`
	SigningAlgorithm string                 `json:"signing_algorithm"`
	CreatedAt        int64                  `json:"created_at"`
	UpdatedAt        int64                  `json:"updated_at"`
}

type JWTTemplatesAPI struct {
	client *Client
}

func NewJWTTemplatesAPI(client *Client) *JWTTemplatesAPI {
	return &JWTTemplatesAPI{client: client}
}

func (a *JWTTemplatesAPI) List() ([]JWTTemplate, int, error) {
	data, err := a.client.Get("/v1/jwt_templates", nil)
	if err != nil {
		return nil, 0, err
	}

	result, err := ParseArrayResponse[JWTTemplate](data)
	if err != nil {
		return nil, 0, err
	}

	return result, len(result), nil
}

func (a *JWTTemplatesAPI) Get(id string) (*JWTTemplate, error) {
	data, err := a.client.Get(fmt.Sprintf("/v1/jwt_templates/%s", id), nil)
	if err != nil {
		return nil, err
	}
	return ParseResponse[*JWTTemplate](data)
}

type CreateJWTTemplateParams struct {
	Name             string                 `json:"name"`
	Claims           map[string]interface{} `json:"claims"`
	Lifetime         int                    `json:"lifetime,omitempty"`
	AllowedClockSkew int                    `json:"allowed_clock_skew,omitempty"`
	SigningAlgorithm string                 `json:"signing_algorithm,omitempty"`
	SigningKey       string                 `json:"signing_key,omitempty"`
}

func (a *JWTTemplatesAPI) Create(params CreateJWTTemplateParams) (*JWTTemplate, error) {
	data, err := a.client.Post("/v1/jwt_templates", params)
	if err != nil {
		return nil, err
	}
	return ParseResponse[*JWTTemplate](data)
}

type UpdateJWTTemplateParams struct {
	Name             string                 `json:"name,omitempty"`
	Claims           map[string]interface{} `json:"claims,omitempty"`
	Lifetime         int                    `json:"lifetime,omitempty"`
	AllowedClockSkew int                    `json:"allowed_clock_skew,omitempty"`
	SigningAlgorithm string                 `json:"signing_algorithm,omitempty"`
	SigningKey       string                 `json:"signing_key,omitempty"`
}

func (a *JWTTemplatesAPI) Update(id string, params UpdateJWTTemplateParams) (*JWTTemplate, error) {
	data, err := a.client.Patch(fmt.Sprintf("/v1/jwt_templates/%s", id), params)
	if err != nil {
		return nil, err
	}
	return ParseResponse[*JWTTemplate](data)
}

func (a *JWTTemplatesAPI) Delete(id string) error {
	_, err := a.client.Delete(fmt.Sprintf("/v1/jwt_templates/%s", id))
	return err
}
