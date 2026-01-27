package api

import (
	"fmt"
	"strconv"
)

// M2M Tokens

type M2MToken struct {
	Object    string   `json:"object"`
	Token     string   `json:"token,omitempty"`
	TokenType string   `json:"token_type"`
	ExpiresIn int      `json:"expires_in"`
	Scopes    []string `json:"scopes,omitempty"`
}

// Machines

type Machine struct {
	ID              string                 `json:"id"`
	Name            string                 `json:"name"`
	ClientID        string                 `json:"client_id"`
	Scopes          []string               `json:"scopes,omitempty"`
	PublicMetadata  map[string]interface{} `json:"public_metadata,omitempty"`
	PrivateMetadata map[string]interface{} `json:"private_metadata,omitempty"`
	LastActiveAt    int64                  `json:"last_active_at,omitempty"`
	CreatedAt       int64                  `json:"created_at"`
	UpdatedAt       int64                  `json:"updated_at"`
}

type MachineSecret struct {
	Object string `json:"object"`
	Secret string `json:"secret"`
}

type M2MAPI struct {
	client *Client
}

func NewM2MAPI(client *Client) *M2MAPI {
	return &M2MAPI{client: client}
}

// Token methods

type ListM2MTokensParams struct {
	MachineID string
	Limit     int
	Offset    int
}

func (a *M2MAPI) ListTokens(params ListM2MTokensParams) ([]M2MToken, int, error) {
	query := make(map[string]string)
	if params.MachineID != "" {
		query["machine_id"] = params.MachineID
	}
	if params.Limit > 0 {
		query["limit"] = strconv.Itoa(params.Limit)
	}
	if params.Offset > 0 {
		query["offset"] = strconv.Itoa(params.Offset)
	}

	data, err := a.client.Get("/v1/m2m_tokens", query)
	if err != nil {
		return nil, 0, err
	}

	result, err := ParseListResponse[M2MToken](data)
	if err != nil {
		return nil, 0, err
	}

	return result.Data, result.TotalCount, nil
}

type CreateM2MTokenParams struct {
	MachineID string   `json:"machine_id"`
	Scopes    []string `json:"scopes,omitempty"`
	ExpiresIn int      `json:"expires_in,omitempty"`
}

func (a *M2MAPI) CreateToken(params CreateM2MTokenParams) (*M2MToken, error) {
	data, err := a.client.Post("/v1/m2m_tokens", params)
	if err != nil {
		return nil, err
	}
	return ParseResponse[*M2MToken](data)
}

type VerifyM2MTokenParams struct {
	Token string `json:"token"`
}

func (a *M2MAPI) VerifyToken(token string) (*M2MToken, error) {
	data, err := a.client.Post("/v1/m2m_tokens/verify", VerifyM2MTokenParams{Token: token})
	if err != nil {
		return nil, err
	}
	return ParseResponse[*M2MToken](data)
}

// Machine methods

type ListMachinesParams struct {
	Limit  int
	Offset int
	Query  string
}

func (a *M2MAPI) ListMachines(params ListMachinesParams) ([]Machine, int, error) {
	query := make(map[string]string)
	if params.Limit > 0 {
		query["limit"] = strconv.Itoa(params.Limit)
	}
	if params.Offset > 0 {
		query["offset"] = strconv.Itoa(params.Offset)
	}
	if params.Query != "" {
		query["query"] = params.Query
	}

	data, err := a.client.Get("/v1/machines", query)
	if err != nil {
		return nil, 0, err
	}

	result, err := ParseListResponse[Machine](data)
	if err != nil {
		return nil, 0, err
	}

	return result.Data, result.TotalCount, nil
}

func (a *M2MAPI) GetMachine(id string) (*Machine, error) {
	data, err := a.client.Get(fmt.Sprintf("/v1/machines/%s", id), nil)
	if err != nil {
		return nil, err
	}
	return ParseResponse[*Machine](data)
}

type CreateMachineParams struct {
	Name            string                 `json:"name"`
	Scopes          []string               `json:"scopes,omitempty"`
	PublicMetadata  map[string]interface{} `json:"public_metadata,omitempty"`
	PrivateMetadata map[string]interface{} `json:"private_metadata,omitempty"`
}

func (a *M2MAPI) CreateMachine(params CreateMachineParams) (*Machine, error) {
	data, err := a.client.Post("/v1/machines", params)
	if err != nil {
		return nil, err
	}
	return ParseResponse[*Machine](data)
}

type UpdateMachineParams struct {
	Name            string                 `json:"name,omitempty"`
	Scopes          []string               `json:"scopes,omitempty"`
	PublicMetadata  map[string]interface{} `json:"public_metadata,omitempty"`
	PrivateMetadata map[string]interface{} `json:"private_metadata,omitempty"`
}

func (a *M2MAPI) UpdateMachine(id string, params UpdateMachineParams) (*Machine, error) {
	data, err := a.client.Patch(fmt.Sprintf("/v1/machines/%s", id), params)
	if err != nil {
		return nil, err
	}
	return ParseResponse[*Machine](data)
}

func (a *M2MAPI) DeleteMachine(id string) error {
	_, err := a.client.Delete(fmt.Sprintf("/v1/machines/%s", id))
	return err
}

func (a *M2MAPI) GetMachineSecret(id string) (*MachineSecret, error) {
	data, err := a.client.Get(fmt.Sprintf("/v1/machines/%s/secret", id), nil)
	if err != nil {
		return nil, err
	}
	return ParseResponse[*MachineSecret](data)
}

type AddScopeParams struct {
	Scope string `json:"scope"`
}

func (a *M2MAPI) AddScope(id string, scope string) (*Machine, error) {
	data, err := a.client.Post(fmt.Sprintf("/v1/machines/%s/scopes", id), AddScopeParams{Scope: scope})
	if err != nil {
		return nil, err
	}
	return ParseResponse[*Machine](data)
}
