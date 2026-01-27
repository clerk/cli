package api

type JWKS struct {
	Keys []JWK `json:"keys"`
}

type JWK struct {
	Use string `json:"use"`
	Kty string `json:"kty"`
	Kid string `json:"kid"`
	Alg string `json:"alg"`
	N   string `json:"n,omitempty"`
	E   string `json:"e,omitempty"`
	Crv string `json:"crv,omitempty"`
	X   string `json:"x,omitempty"`
	Y   string `json:"y,omitempty"`
}

type JWKSAPI struct {
	client *Client
}

func NewJWKSAPI(client *Client) *JWKSAPI {
	return &JWKSAPI{client: client}
}

func (a *JWKSAPI) Get() (*JWKS, error) {
	data, err := a.client.Get("/v1/jwks", nil)
	if err != nil {
		return nil, err
	}
	return ParseResponse[*JWKS](data)
}
