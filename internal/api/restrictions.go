package api

import (
	"strings"

	clerk "github.com/clerk/clerk-sdk-go/v2"
	sdkallowlist "github.com/clerk/clerk-sdk-go/v2/allowlistidentifier"
	sdkblocklist "github.com/clerk/clerk-sdk-go/v2/blocklistidentifier"
)

type RestrictionsAPI struct {
	client          *Client
	allowlistClient *sdkallowlist.Client
	blocklistClient *sdkblocklist.Client
}

func NewRestrictionsAPI(client *Client) *RestrictionsAPI {
	return &RestrictionsAPI{
		client:          client,
		allowlistClient: sdkallowlist.NewClient(client.SDKConfig()),
		blocklistClient: sdkblocklist.NewClient(client.SDKConfig()),
	}
}

func (a *RestrictionsAPI) ListAllowlist() (*clerk.AllowlistIdentifierList, error) {
	return a.allowlistClient.List(a.client.Context(), &sdkallowlist.ListParams{})
}

func (a *RestrictionsAPI) ListBlocklist() (*clerk.BlocklistIdentifierList, error) {
	return a.blocklistClient.List(a.client.Context(), &sdkblocklist.ListParams{})
}

func (a *RestrictionsAPI) AddToAllowlist(params sdkallowlist.CreateParams) (*clerk.AllowlistIdentifier, error) {
	return a.allowlistClient.Create(a.client.Context(), &params)
}

func (a *RestrictionsAPI) AddToBlocklist(params sdkblocklist.CreateParams) (*clerk.BlocklistIdentifier, error) {
	return a.blocklistClient.Create(a.client.Context(), &params)
}

func (a *RestrictionsAPI) Remove(id string) error {
	if strings.HasPrefix(id, "blid_") {
		_, err := a.blocklistClient.Delete(a.client.Context(), id)
		return err
	}
	_, err := a.allowlistClient.Delete(a.client.Context(), id)
	return err
}
