package api

import (
	"fmt"

	clerk "github.com/clerk/clerk-sdk-go/v2"
	sdkm2mtoken "github.com/clerk/clerk-sdk-go/v2/m2m_token"
	sdkmachine "github.com/clerk/clerk-sdk-go/v2/machine"
)

type M2MAPI struct {
	client         *Client
	machineClient  *sdkmachine.Client
	m2mTokenClient *sdkm2mtoken.Client
}

func NewM2MAPI(client *Client) *M2MAPI {
	return &M2MAPI{
		client:         client,
		machineClient:  sdkmachine.NewClient(client.SDKConfig()),
		m2mTokenClient: sdkm2mtoken.NewClient(client.SDKConfig()),
	}
}

// Token methods

func (a *M2MAPI) ListTokens(params sdkm2mtoken.ListParams) (*clerk.M2MTokenList, error) {
	return a.m2mTokenClient.List(a.client.Context(), &params)
}

func (a *M2MAPI) CreateToken(params sdkm2mtoken.CreateParams) (*clerk.M2MTokenWithToken, error) {
	return a.m2mTokenClient.Create(a.client.Context(), &params)
}

func (a *M2MAPI) VerifyToken(params sdkm2mtoken.VerifyParams) (*clerk.M2MToken, error) {
	return a.m2mTokenClient.Verify(a.client.Context(), &params)
}

// Machine methods

func (a *M2MAPI) ListMachines(params sdkmachine.ListParams) (*clerk.MachineList, error) {
	return a.machineClient.List(a.client.Context(), &params)
}

func (a *M2MAPI) GetMachine(id string) (*clerk.MachineWithScopedMachines, error) {
	return a.machineClient.Get(a.client.Context(), id)
}

func (a *M2MAPI) CreateMachine(params sdkmachine.CreateParams) (*clerk.MachineWithScopedMachinesAndSecretKey, error) {
	return a.machineClient.Create(a.client.Context(), &params)
}

func (a *M2MAPI) UpdateMachine(id string, params sdkmachine.UpdateParams) (*clerk.MachineWithScopedMachines, error) {
	return a.machineClient.Update(a.client.Context(), id, &params)
}

func (a *M2MAPI) DeleteMachine(id string) error {
	_, err := a.machineClient.Delete(a.client.Context(), id)
	return err
}

func (a *M2MAPI) GetMachineSecret(id string) (*clerk.MachineSecretKey, error) {
	return a.machineClient.GetSecretKey(a.client.Context(), id)
}

// AddScope has no SDK equivalent, so we use the raw client.
func (a *M2MAPI) AddScope(id string, scope string) error {
	_, err := a.client.Post(fmt.Sprintf("/v1/machines/%s/scopes", id), map[string]string{"scope": scope})
	return err
}
