package api

import (
	"fmt"
	"strconv"
)

type Session struct {
	ID           string `json:"id"`
	ClientID     string `json:"client_id"`
	UserID       string `json:"user_id"`
	Status       string `json:"status"`
	LastActiveAt int64  `json:"last_active_at"`
	ExpireAt     int64  `json:"expire_at"`
	AbandonAt    int64  `json:"abandon_at"`
	CreatedAt    int64  `json:"created_at"`
	UpdatedAt    int64  `json:"updated_at"`
}

type SessionsAPI struct {
	client *Client
}

func NewSessionsAPI(client *Client) *SessionsAPI {
	return &SessionsAPI{client: client}
}

type ListSessionsParams struct {
	ClientID string
	UserID   string
	Status   string
	Limit    int
	Offset   int
}

func (a *SessionsAPI) List(params ListSessionsParams) ([]Session, int, error) {
	query := make(map[string]string)
	if params.ClientID != "" {
		query["client_id"] = params.ClientID
	}
	if params.UserID != "" {
		query["user_id"] = params.UserID
	}
	if params.Status != "" {
		query["status"] = params.Status
	}
	if params.Limit > 0 {
		query["limit"] = strconv.Itoa(params.Limit)
	}
	if params.Offset > 0 {
		query["offset"] = strconv.Itoa(params.Offset)
	}

	data, err := a.client.Get("/v1/sessions", query)
	if err != nil {
		return nil, 0, err
	}

	// Sessions API returns a raw array, not a wrapped response
	sessions, err := ParseArrayResponse[Session](data)
	if err != nil {
		return nil, 0, err
	}

	return sessions, len(sessions), nil
}

func (a *SessionsAPI) Get(id string) (*Session, error) {
	data, err := a.client.Get(fmt.Sprintf("/v1/sessions/%s", id), nil)
	if err != nil {
		return nil, err
	}
	return ParseResponse[*Session](data)
}

func (a *SessionsAPI) Revoke(id string) (*Session, error) {
	data, err := a.client.Post(fmt.Sprintf("/v1/sessions/%s/revoke", id), nil)
	if err != nil {
		return nil, err
	}
	return ParseResponse[*Session](data)
}
