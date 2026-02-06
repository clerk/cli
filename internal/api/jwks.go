package api

import (
	clerk "github.com/clerk/clerk-sdk-go/v2"
	sdkjwks "github.com/clerk/clerk-sdk-go/v2/jwks"
)

type JWKSAPI struct {
	client    *Client
	sdkClient *sdkjwks.Client
}

func NewJWKSAPI(client *Client) *JWKSAPI {
	return &JWKSAPI{
		client:    client,
		sdkClient: sdkjwks.NewClient(client.SDKConfig()),
	}
}

func (a *JWKSAPI) Get() (*clerk.JSONWebKeySet, error) {
	return a.sdkClient.Get(a.client.Context(), &sdkjwks.GetParams{})
}
