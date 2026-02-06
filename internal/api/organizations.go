package api

import (
	clerk "github.com/clerk/clerk-sdk-go/v2"
	sdkorg "github.com/clerk/clerk-sdk-go/v2/organization"
	sdkorginvitation "github.com/clerk/clerk-sdk-go/v2/organizationinvitation"
	sdkmembership "github.com/clerk/clerk-sdk-go/v2/organizationmembership"
)

type OrganizationsAPI struct {
	client              *Client
	sdkOrgClient        *sdkorg.Client
	sdkMembershipClient *sdkmembership.Client
	sdkInvitationClient *sdkorginvitation.Client
}

func NewOrganizationsAPI(client *Client) *OrganizationsAPI {
	config := client.SDKConfig()
	return &OrganizationsAPI{
		client:              client,
		sdkOrgClient:        sdkorg.NewClient(config),
		sdkMembershipClient: sdkmembership.NewClient(config),
		sdkInvitationClient: sdkorginvitation.NewClient(config),
	}
}

func (a *OrganizationsAPI) List(params sdkorg.ListParams) (*clerk.OrganizationList, error) {
	return a.sdkOrgClient.List(a.client.Context(), &params)
}

func (a *OrganizationsAPI) Get(id string) (*clerk.Organization, error) {
	return a.sdkOrgClient.Get(a.client.Context(), id)
}

func (a *OrganizationsAPI) Create(params sdkorg.CreateParams) (*clerk.Organization, error) {
	return a.sdkOrgClient.Create(a.client.Context(), &params)
}

func (a *OrganizationsAPI) Update(id string, params sdkorg.UpdateParams) (*clerk.Organization, error) {
	return a.sdkOrgClient.Update(a.client.Context(), id, &params)
}

func (a *OrganizationsAPI) Delete(id string) error {
	_, err := a.sdkOrgClient.Delete(a.client.Context(), id)
	return err
}

// Members

func (a *OrganizationsAPI) ListMembers(params sdkmembership.ListParams) (*clerk.OrganizationMembershipList, error) {
	return a.sdkMembershipClient.List(a.client.Context(), &params)
}

func (a *OrganizationsAPI) AddMember(params sdkmembership.CreateParams) (*clerk.OrganizationMembership, error) {
	return a.sdkMembershipClient.Create(a.client.Context(), &params)
}

func (a *OrganizationsAPI) UpdateMember(params sdkmembership.UpdateParams) (*clerk.OrganizationMembership, error) {
	return a.sdkMembershipClient.Update(a.client.Context(), &params)
}

func (a *OrganizationsAPI) RemoveMember(params sdkmembership.DeleteParams) error {
	_, err := a.sdkMembershipClient.Delete(a.client.Context(), &params)
	return err
}

// Invitations

func (a *OrganizationsAPI) ListInvitations(params sdkorginvitation.ListParams) (*clerk.OrganizationInvitationList, error) {
	return a.sdkInvitationClient.List(a.client.Context(), &params)
}

func (a *OrganizationsAPI) CreateInvitation(params sdkorginvitation.CreateParams) (*clerk.OrganizationInvitation, error) {
	return a.sdkInvitationClient.Create(a.client.Context(), &params)
}

func (a *OrganizationsAPI) RevokeInvitation(params sdkorginvitation.RevokeParams) (*clerk.OrganizationInvitation, error) {
	return a.sdkInvitationClient.Revoke(a.client.Context(), &params)
}
