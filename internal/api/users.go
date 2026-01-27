package api

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

type User struct {
	ID                string                 `json:"id"`
	ExternalID        string                 `json:"external_id,omitempty"`
	FirstName         string                 `json:"first_name,omitempty"`
	LastName          string                 `json:"last_name,omitempty"`
	Username          string                 `json:"username,omitempty"`
	EmailAddresses    []EmailAddress         `json:"email_addresses,omitempty"`
	PhoneNumbers      []PhoneNumber          `json:"phone_numbers,omitempty"`
	PrimaryEmailID    string                 `json:"primary_email_address_id,omitempty"`
	PrimaryPhoneID    string                 `json:"primary_phone_number_id,omitempty"`
	ImageURL          string                 `json:"image_url,omitempty"`
	ProfileImageURL   string                 `json:"profile_image_url,omitempty"`
	PublicMetadata    map[string]interface{} `json:"public_metadata,omitempty"`
	PrivateMetadata   map[string]interface{} `json:"private_metadata,omitempty"`
	UnsafeMetadata    map[string]interface{} `json:"unsafe_metadata,omitempty"`
	Banned            bool                   `json:"banned"`
	Locked            bool                   `json:"locked"`
	LastSignInAt      int64                  `json:"last_sign_in_at,omitempty"`
	CreatedAt         int64                  `json:"created_at"`
	UpdatedAt         int64                  `json:"updated_at"`
}

type EmailAddress struct {
	ID           string `json:"id"`
	EmailAddress string `json:"email_address"`
	Verified     bool   `json:"verified,omitempty"`
}

type PhoneNumber struct {
	ID          string `json:"id"`
	PhoneNumber string `json:"phone_number"`
	Verified    bool   `json:"verified,omitempty"`
}

type UsersAPI struct {
	client *Client
}

func NewUsersAPI(client *Client) *UsersAPI {
	return &UsersAPI{client: client}
}

type ListUsersParams struct {
	Limit           int
	Offset          int
	OrderBy         string
	Query           string
	EmailAddress    []string
	PhoneNumber     []string
	ExternalID      []string
	Username        []string
	UserID          []string
	OrganizationID  []string
	LastActiveSince int64
}

func (a *UsersAPI) List(params ListUsersParams) ([]User, int, error) {
	query := make(map[string]string)
	if params.Limit > 0 {
		query["limit"] = strconv.Itoa(params.Limit)
	}
	if params.Offset > 0 {
		query["offset"] = strconv.Itoa(params.Offset)
	}
	if params.OrderBy != "" {
		query["order_by"] = params.OrderBy
	}
	if params.Query != "" {
		query["query"] = params.Query
	}
	if len(params.EmailAddress) > 0 {
		query["email_address"] = strings.Join(params.EmailAddress, ",")
	}
	if len(params.PhoneNumber) > 0 {
		query["phone_number"] = strings.Join(params.PhoneNumber, ",")
	}
	if len(params.ExternalID) > 0 {
		query["external_id"] = strings.Join(params.ExternalID, ",")
	}
	if len(params.Username) > 0 {
		query["username"] = strings.Join(params.Username, ",")
	}
	if len(params.UserID) > 0 {
		query["user_id"] = strings.Join(params.UserID, ",")
	}
	if len(params.OrganizationID) > 0 {
		query["organization_id"] = strings.Join(params.OrganizationID, ",")
	}
	if params.LastActiveSince > 0 {
		query["last_active_at_since"] = strconv.FormatInt(params.LastActiveSince, 10)
	}

	data, err := a.client.Get("/v1/users", query)
	if err != nil {
		return nil, 0, err
	}

	// The API returns a plain array of users
	var users []User
	if err := json.Unmarshal(data, &users); err != nil {
		return nil, 0, fmt.Errorf("failed to parse response: %w", err)
	}

	return users, len(users), nil
}

func (a *UsersAPI) Count(params ListUsersParams) (int, error) {
	query := make(map[string]string)
	if params.Query != "" {
		query["query"] = params.Query
	}

	data, err := a.client.Get("/v1/users/count", query)
	if err != nil {
		return 0, err
	}

	var result struct {
		Object     string `json:"object"`
		TotalCount int    `json:"total_count"`
	}
	if err := json.Unmarshal(data, &result); err != nil {
		return 0, fmt.Errorf("failed to parse response: %w", err)
	}

	return result.TotalCount, nil
}

func (a *UsersAPI) Get(id string) (*User, error) {
	data, err := a.client.Get(fmt.Sprintf("/v1/users/%s", id), nil)
	if err != nil {
		return nil, err
	}
	return ParseResponse[*User](data)
}

type CreateUserParams struct {
	ExternalID      string                 `json:"external_id,omitempty"`
	FirstName       string                 `json:"first_name,omitempty"`
	LastName        string                 `json:"last_name,omitempty"`
	EmailAddress    []string               `json:"email_address,omitempty"`
	PhoneNumber     []string               `json:"phone_number,omitempty"`
	Username        string                 `json:"username,omitempty"`
	Password        string                 `json:"password,omitempty"`
	SkipPasswordReq bool                   `json:"skip_password_requirement,omitempty"`
	PublicMetadata  map[string]interface{} `json:"public_metadata,omitempty"`
	PrivateMetadata map[string]interface{} `json:"private_metadata,omitempty"`
	UnsafeMetadata  map[string]interface{} `json:"unsafe_metadata,omitempty"`
}

func (a *UsersAPI) Create(params CreateUserParams) (*User, error) {
	data, err := a.client.Post("/v1/users", params)
	if err != nil {
		return nil, err
	}
	return ParseResponse[*User](data)
}

type UpdateUserParams struct {
	ExternalID      string                 `json:"external_id,omitempty"`
	FirstName       string                 `json:"first_name,omitempty"`
	LastName        string                 `json:"last_name,omitempty"`
	Username        string                 `json:"username,omitempty"`
	Password        string                 `json:"password,omitempty"`
	PublicMetadata  map[string]interface{} `json:"public_metadata,omitempty"`
	PrivateMetadata map[string]interface{} `json:"private_metadata,omitempty"`
	UnsafeMetadata  map[string]interface{} `json:"unsafe_metadata,omitempty"`
}

func (a *UsersAPI) Update(id string, params UpdateUserParams) (*User, error) {
	data, err := a.client.Patch(fmt.Sprintf("/v1/users/%s", id), params)
	if err != nil {
		return nil, err
	}
	return ParseResponse[*User](data)
}

func (a *UsersAPI) Delete(id string) error {
	_, err := a.client.Delete(fmt.Sprintf("/v1/users/%s", id))
	return err
}

func (a *UsersAPI) Ban(id string) (*User, error) {
	data, err := a.client.Post(fmt.Sprintf("/v1/users/%s/ban", id), nil)
	if err != nil {
		return nil, err
	}
	return ParseResponse[*User](data)
}

func (a *UsersAPI) Unban(id string) (*User, error) {
	data, err := a.client.Post(fmt.Sprintf("/v1/users/%s/unban", id), nil)
	if err != nil {
		return nil, err
	}
	return ParseResponse[*User](data)
}

func (a *UsersAPI) Lock(id string) (*User, error) {
	data, err := a.client.Post(fmt.Sprintf("/v1/users/%s/lock", id), nil)
	if err != nil {
		return nil, err
	}
	return ParseResponse[*User](data)
}

func (a *UsersAPI) Unlock(id string) (*User, error) {
	data, err := a.client.Post(fmt.Sprintf("/v1/users/%s/unlock", id), nil)
	if err != nil {
		return nil, err
	}
	return ParseResponse[*User](data)
}

func (a *UsersAPI) VerifyPassword(id, password string) (bool, error) {
	data, err := a.client.Post(fmt.Sprintf("/v1/users/%s/verify_password", id), map[string]string{
		"password": password,
	})
	if err != nil {
		return false, err
	}

	var result struct {
		Verified bool `json:"verified"`
	}
	if err := parseJSON(data, &result); err != nil {
		return false, err
	}

	return result.Verified, nil
}

func parseJSON(data []byte, v interface{}) error {
	if err := json.Unmarshal(data, v); err != nil {
		return fmt.Errorf("failed to parse response: %w", err)
	}
	return nil
}
