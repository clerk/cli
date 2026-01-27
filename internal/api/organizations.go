package api

import (
	"encoding/json"
	"fmt"
	"strconv"
)

type Organization struct {
	ID              string                 `json:"id"`
	Name            string                 `json:"name"`
	Slug            string                 `json:"slug,omitempty"`
	ImageURL        string                 `json:"image_url,omitempty"`
	MaxAllowedMemberships int              `json:"max_allowed_memberships,omitempty"`
	PublicMetadata  map[string]interface{} `json:"public_metadata,omitempty"`
	PrivateMetadata map[string]interface{} `json:"private_metadata,omitempty"`
	CreatedAt       int64                  `json:"created_at"`
	UpdatedAt       int64                  `json:"updated_at"`
}

type OrganizationMembership struct {
	ID             string                 `json:"id"`
	Organization   Organization           `json:"organization"`
	PublicUserData map[string]interface{} `json:"public_user_data,omitempty"`
	Role           string                 `json:"role"`
	CreatedAt      int64                  `json:"created_at"`
	UpdatedAt      int64                  `json:"updated_at"`
}

type OrganizationInvitation struct {
	ID             string `json:"id"`
	EmailAddress   string `json:"email_address"`
	OrganizationID string `json:"organization_id"`
	Role           string `json:"role"`
	Status         string `json:"status"`
	CreatedAt      int64  `json:"created_at"`
	UpdatedAt      int64  `json:"updated_at"`
}

type OrganizationsAPI struct {
	client *Client
}

func NewOrganizationsAPI(client *Client) *OrganizationsAPI {
	return &OrganizationsAPI{client: client}
}

type ListOrganizationsParams struct {
	Limit   int
	Offset  int
	OrderBy string
	Query   string
}

func (a *OrganizationsAPI) List(params ListOrganizationsParams) ([]Organization, int, error) {
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

	data, err := a.client.Get("/v1/organizations", query)
	if err != nil {
		return nil, 0, err
	}

	result, err := ParseListResponse[Organization](data)
	if err != nil {
		return nil, 0, err
	}

	return result.Data, result.TotalCount, nil
}

func (a *OrganizationsAPI) Get(id string) (*Organization, error) {
	data, err := a.client.Get(fmt.Sprintf("/v1/organizations/%s", id), nil)
	if err != nil {
		return nil, err
	}
	return ParseResponse[*Organization](data)
}

type CreateOrganizationParams struct {
	Name                  string                 `json:"name"`
	Slug                  string                 `json:"slug,omitempty"`
	CreatedBy             string                 `json:"created_by,omitempty"`
	MaxAllowedMemberships int                    `json:"max_allowed_memberships,omitempty"`
	PublicMetadata        map[string]interface{} `json:"public_metadata,omitempty"`
	PrivateMetadata       map[string]interface{} `json:"private_metadata,omitempty"`
}

func (a *OrganizationsAPI) Create(params CreateOrganizationParams) (*Organization, error) {
	data, err := a.client.Post("/v1/organizations", params)
	if err != nil {
		return nil, err
	}
	return ParseResponse[*Organization](data)
}

type UpdateOrganizationParams struct {
	Name                  string                 `json:"name,omitempty"`
	Slug                  string                 `json:"slug,omitempty"`
	MaxAllowedMemberships int                    `json:"max_allowed_memberships,omitempty"`
	PublicMetadata        map[string]interface{} `json:"public_metadata,omitempty"`
	PrivateMetadata       map[string]interface{} `json:"private_metadata,omitempty"`
}

func (a *OrganizationsAPI) Update(id string, params UpdateOrganizationParams) (*Organization, error) {
	data, err := a.client.Patch(fmt.Sprintf("/v1/organizations/%s", id), params)
	if err != nil {
		return nil, err
	}
	return ParseResponse[*Organization](data)
}

func (a *OrganizationsAPI) Delete(id string) error {
	_, err := a.client.Delete(fmt.Sprintf("/v1/organizations/%s", id))
	return err
}

// Members

type ListMembersParams struct {
	Limit   int
	Offset  int
	OrderBy string
}

func (a *OrganizationsAPI) ListMembers(orgID string, params ListMembersParams) ([]OrganizationMembership, int, error) {
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

	data, err := a.client.Get(fmt.Sprintf("/v1/organizations/%s/memberships", orgID), query)
	if err != nil {
		return nil, 0, err
	}

	result, err := ParseListResponse[OrganizationMembership](data)
	if err != nil {
		return nil, 0, err
	}

	return result.Data, result.TotalCount, nil
}

type AddMemberParams struct {
	UserID string `json:"user_id"`
	Role   string `json:"role"`
}

func (a *OrganizationsAPI) AddMember(orgID string, params AddMemberParams) (*OrganizationMembership, error) {
	data, err := a.client.Post(fmt.Sprintf("/v1/organizations/%s/memberships", orgID), params)
	if err != nil {
		return nil, err
	}
	return ParseResponse[*OrganizationMembership](data)
}

type UpdateMemberParams struct {
	Role string `json:"role"`
}

func (a *OrganizationsAPI) UpdateMember(orgID, userID string, params UpdateMemberParams) (*OrganizationMembership, error) {
	data, err := a.client.Patch(fmt.Sprintf("/v1/organizations/%s/memberships/%s", orgID, userID), params)
	if err != nil {
		return nil, err
	}
	return ParseResponse[*OrganizationMembership](data)
}

func (a *OrganizationsAPI) RemoveMember(orgID, userID string) error {
	_, err := a.client.Delete(fmt.Sprintf("/v1/organizations/%s/memberships/%s", orgID, userID))
	return err
}

// Invitations

type ListOrgInvitationsParams struct {
	Limit  int
	Offset int
	Status string
}

func (a *OrganizationsAPI) ListInvitations(orgID string, params ListOrgInvitationsParams) ([]OrganizationInvitation, int, error) {
	query := make(map[string]string)
	if params.Limit > 0 {
		query["limit"] = strconv.Itoa(params.Limit)
	}
	if params.Offset > 0 {
		query["offset"] = strconv.Itoa(params.Offset)
	}
	if params.Status != "" {
		query["status"] = params.Status
	}

	data, err := a.client.Get(fmt.Sprintf("/v1/organizations/%s/invitations", orgID), query)
	if err != nil {
		return nil, 0, err
	}

	result, err := ParseListResponse[OrganizationInvitation](data)
	if err != nil {
		return nil, 0, err
	}

	return result.Data, result.TotalCount, nil
}

type CreateOrgInvitationParams struct {
	EmailAddress   string                 `json:"email_address"`
	Role           string                 `json:"role"`
	RedirectURL    string                 `json:"redirect_url,omitempty"`
	PublicMetadata map[string]interface{} `json:"public_metadata,omitempty"`
}

func (a *OrganizationsAPI) CreateInvitation(orgID string, params CreateOrgInvitationParams) (*OrganizationInvitation, error) {
	data, err := a.client.Post(fmt.Sprintf("/v1/organizations/%s/invitations", orgID), params)
	if err != nil {
		return nil, err
	}
	return ParseResponse[*OrganizationInvitation](data)
}

func (a *OrganizationsAPI) RevokeInvitation(orgID, invitationID string) (*OrganizationInvitation, error) {
	data, err := a.client.Post(fmt.Sprintf("/v1/organizations/%s/invitations/%s/revoke", orgID, invitationID), nil)
	if err != nil {
		return nil, err
	}
	return ParseResponse[*OrganizationInvitation](data)
}

func init() {
	_ = json.Marshal
}
