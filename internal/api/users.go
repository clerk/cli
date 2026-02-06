package api

import (
	clerk "github.com/clerk/clerk-sdk-go/v2"
	sdkuser "github.com/clerk/clerk-sdk-go/v2/user"
)

type UsersAPI struct {
	client    *Client
	sdkClient *sdkuser.Client
}

func NewUsersAPI(client *Client) *UsersAPI {
	return &UsersAPI{
		client:    client,
		sdkClient: sdkuser.NewClient(client.SDKConfig()),
	}
}

func (a *UsersAPI) List(params sdkuser.ListParams) (*clerk.UserList, error) {
	ctx := a.client.Context()
	return a.sdkClient.List(ctx, &params)
}

func (a *UsersAPI) Count(params sdkuser.ListParams) (int64, error) {
	ctx := a.client.Context()
	result, err := a.sdkClient.Count(ctx, &params)
	if err != nil {
		return 0, err
	}
	return result.TotalCount, nil
}

func (a *UsersAPI) Get(id string) (*clerk.User, error) {
	return a.sdkClient.Get(a.client.Context(), id)
}

func (a *UsersAPI) Create(params sdkuser.CreateParams) (*clerk.User, error) {
	return a.sdkClient.Create(a.client.Context(), &params)
}

func (a *UsersAPI) Update(id string, params sdkuser.UpdateParams) (*clerk.User, error) {
	return a.sdkClient.Update(a.client.Context(), id, &params)
}

func (a *UsersAPI) Delete(id string) error {
	_, err := a.sdkClient.Delete(a.client.Context(), id)
	return err
}

func (a *UsersAPI) Ban(id string) (*clerk.User, error) {
	return a.sdkClient.Ban(a.client.Context(), id)
}

func (a *UsersAPI) Unban(id string) (*clerk.User, error) {
	return a.sdkClient.Unban(a.client.Context(), id)
}

func (a *UsersAPI) Lock(id string) (*clerk.User, error) {
	return a.sdkClient.Lock(a.client.Context(), id)
}

func (a *UsersAPI) Unlock(id string) (*clerk.User, error) {
	return a.sdkClient.Unlock(a.client.Context(), id)
}

func (a *UsersAPI) VerifyPassword(id, password string) (bool, error) {
	result, err := a.sdkClient.VerifyPassword(a.client.Context(), &sdkuser.VerifyPasswordParams{
		UserID:   id,
		Password: password,
	})
	if err != nil {
		return false, err
	}
	return result.Verified, nil
}
