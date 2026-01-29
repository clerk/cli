package api

import (
	"fmt"
	"strconv"
)

// PlanFee represents a fee amount with formatting
type PlanFee struct {
	Amount          int64  `json:"amount"`
	AmountFormatted string `json:"amount_formatted,omitempty"`
	Currency        string `json:"currency,omitempty"`
	CurrencySymbol  string `json:"currency_symbol,omitempty"`
}

// BillingPlan represents a billing plan
type BillingPlan struct {
	ID                           string                 `json:"id"`
	Object                       string                 `json:"object,omitempty"`
	Name                         string                 `json:"name"`
	Key                          string                 `json:"key,omitempty"`
	Slug                         string                 `json:"slug,omitempty"`
	Description                  string                 `json:"description,omitempty"`
	ProductID                    string                 `json:"product_id,omitempty"`
	AvatarURL                    string                 `json:"avatar_url,omitempty"`
	Fee                          *PlanFee               `json:"fee,omitempty"`
	AnnualFee                    *PlanFee               `json:"annual_fee,omitempty"`
	AnnualMonthlyFee             *PlanFee               `json:"annual_monthly_fee,omitempty"`
	Amount                       int64                  `json:"amount,omitempty"`
	AmountFormatted              string                 `json:"amount_formatted,omitempty"`
	AnnualAmount                 int64                  `json:"annual_amount,omitempty"`
	AnnualAmountFormatted        string                 `json:"annual_amount_formatted,omitempty"`
	AnnualMonthlyAmount          int64                  `json:"annual_monthly_amount,omitempty"`
	AnnualMonthlyAmountFormatted string                 `json:"annual_monthly_amount_formatted,omitempty"`
	Currency                     string                 `json:"currency,omitempty"`
	CurrencySymbol               string                 `json:"currency_symbol,omitempty"`
	IsDefault                    bool                   `json:"is_default,omitempty"`
	IsRecurring                  bool                   `json:"is_recurring,omitempty"`
	PubliclyVisible              bool                   `json:"publicly_visible,omitempty"`
	HasBaseFee                   bool                   `json:"has_base_fee,omitempty"`
	PayerType                    []string               `json:"payer_type,omitempty"`
	ForPayerType                 string                 `json:"for_payer_type,omitempty"`
	FreeTrialEnabled             bool                   `json:"free_trial_enabled,omitempty"`
	FreeTrialDays                *int                   `json:"free_trial_days,omitempty"`
	Features                     interface{}            `json:"features,omitempty"`
	Metadata                     map[string]interface{} `json:"metadata,omitempty"`
	CreatedAt                    int64                  `json:"created_at,omitempty"`
	UpdatedAt                    int64                  `json:"updated_at,omitempty"`
}

// Subscription represents a billing subscription
type Subscription struct {
	ID                   string             `json:"id"`
	Object               string             `json:"object,omitempty"`
	InstanceID           string             `json:"instance_id,omitempty"`
	Status               string             `json:"status,omitempty"`
	PayerID              string             `json:"payer_id,omitempty"`
	ActiveAt             *int64             `json:"active_at,omitempty"`
	PastDueAt            *int64             `json:"past_due_at,omitempty"`
	SubscriptionItems    []SubscriptionItem `json:"subscription_items,omitempty"`
	EligibleForFreeTrial bool               `json:"eligible_for_free_trial,omitempty"`
	CreatedAt            int64              `json:"created_at,omitempty"`
	UpdatedAt            int64              `json:"updated_at,omitempty"`
}

// SubscriptionItem represents a subscription item
type SubscriptionItem struct {
	ID              string       `json:"id"`
	Object          string       `json:"object,omitempty"`
	InstanceID      string       `json:"instance_id,omitempty"`
	SubscriptionID  string       `json:"subscription_id,omitempty"`
	Status          string       `json:"status,omitempty"`
	PlanID          string       `json:"plan_id,omitempty"`
	Plan            *BillingPlan `json:"plan,omitempty"`
	PriceID         string       `json:"price_id,omitempty"`
	PlanPeriod      string       `json:"plan_period,omitempty"`
	PaymentSourceID string       `json:"payment_source_id,omitempty"`
	PayerID         string       `json:"payer_id,omitempty"`
	IsFreeTrial     bool         `json:"is_free_trial,omitempty"`
	PeriodStart     *int64       `json:"period_start,omitempty"`
	PeriodEnd       *int64       `json:"period_end,omitempty"`
	CanceledAt      *int64       `json:"canceled_at,omitempty"`
	PastDueAt       *int64       `json:"past_due_at,omitempty"`
	EndedAt         *int64       `json:"ended_at,omitempty"`
	CreatedAt       int64        `json:"created_at,omitempty"`
	UpdatedAt       int64        `json:"updated_at,omitempty"`
}

// Statement represents a billing statement
type Statement struct {
	ID              string                 `json:"id"`
	Object          string                 `json:"object,omitempty"`
	Status          string                 `json:"status,omitempty"`
	Amount          int64                  `json:"amount,omitempty"`
	Currency        string                 `json:"currency,omitempty"`
	DueDate         int64                  `json:"due_date,omitempty"`
	PaidAt          int64                  `json:"paid_at,omitempty"`
	PeriodStart     int64                  `json:"period_start,omitempty"`
	PeriodEnd       int64                  `json:"period_end,omitempty"`
	Metadata        map[string]interface{} `json:"metadata,omitempty"`
	CreatedAt       int64                  `json:"created_at,omitempty"`
	UpdatedAt       int64                  `json:"updated_at,omitempty"`
}

// PaymentAttempt represents a payment attempt on a statement
type PaymentAttempt struct {
	ID            string                 `json:"id"`
	Object        string                 `json:"object,omitempty"`
	StatementID   string                 `json:"statement_id,omitempty"`
	Status        string                 `json:"status,omitempty"`
	Amount        int64                  `json:"amount,omitempty"`
	Currency      string                 `json:"currency,omitempty"`
	FailureReason string                 `json:"failure_reason,omitempty"`
	Metadata      map[string]interface{} `json:"metadata,omitempty"`
	CreatedAt     int64                  `json:"created_at,omitempty"`
}

type BillingAPI struct {
	client *Client
}

func NewBillingAPI(client *Client) *BillingAPI {
	return &BillingAPI{client: client}
}

// ListPlansParams contains parameters for listing billing plans
type ListPlansParams struct {
	Limit  int
	Offset int
}

// ListPlans retrieves all billing plans
func (a *BillingAPI) ListPlans(params ListPlansParams) ([]BillingPlan, int, error) {
	query := make(map[string]string)
	if params.Limit > 0 {
		query["limit"] = strconv.Itoa(params.Limit)
	}
	if params.Offset > 0 {
		query["offset"] = strconv.Itoa(params.Offset)
	}

	data, err := a.client.Get("/v1/billing/plans", query)
	if err != nil {
		return nil, 0, err
	}

	result, err := ParseListResponse[BillingPlan](data)
	if err != nil {
		return nil, 0, err
	}

	return result.Data, result.TotalCount, nil
}

// GetUserSubscription retrieves the billing subscription for a user
func (a *BillingAPI) GetUserSubscription(userID string) (*Subscription, error) {
	data, err := a.client.Get(fmt.Sprintf("/v1/users/%s/billing/subscription", userID), nil)
	if err != nil {
		return nil, err
	}
	return ParseResponse[*Subscription](data)
}

// GetOrganizationSubscription retrieves the billing subscription for an organization
func (a *BillingAPI) GetOrganizationSubscription(orgID string) (*Subscription, error) {
	data, err := a.client.Get(fmt.Sprintf("/v1/organizations/%s/billing/subscription", orgID), nil)
	if err != nil {
		return nil, err
	}
	return ParseResponse[*Subscription](data)
}

// ListSubscriptionItemsParams contains parameters for listing subscription items
type ListSubscriptionItemsParams struct {
	Limit  int
	Offset int
}

// ListSubscriptionItems retrieves all subscription items
func (a *BillingAPI) ListSubscriptionItems(params ListSubscriptionItemsParams) ([]SubscriptionItem, int, error) {
	query := make(map[string]string)
	if params.Limit > 0 {
		query["limit"] = strconv.Itoa(params.Limit)
	}
	if params.Offset > 0 {
		query["offset"] = strconv.Itoa(params.Offset)
	}

	data, err := a.client.Get("/v1/billing/subscription_items", query)
	if err != nil {
		return nil, 0, err
	}

	result, err := ParseListResponse[SubscriptionItem](data)
	if err != nil {
		return nil, 0, err
	}

	return result.Data, result.TotalCount, nil
}

// DeleteSubscriptionItem deletes a subscription item
func (a *BillingAPI) DeleteSubscriptionItem(id string) error {
	_, err := a.client.Delete(fmt.Sprintf("/v1/billing/subscription_items/%s", id))
	return err
}

// ExtendFreeTrialParams contains parameters for extending a free trial
type ExtendFreeTrialParams struct {
	Days int `json:"days,omitempty"`
}

// ExtendFreeTrial extends the free trial for a subscription item
func (a *BillingAPI) ExtendFreeTrial(id string, params ExtendFreeTrialParams) (*SubscriptionItem, error) {
	data, err := a.client.Post(fmt.Sprintf("/v1/billing/subscription_items/%s/extend_free_trial", id), params)
	if err != nil {
		return nil, err
	}
	return ParseResponse[*SubscriptionItem](data)
}

// PriceTransitionParams contains parameters for price transition
type PriceTransitionParams struct {
	PriceID   string `json:"price_id,omitempty"`
	Immediate bool   `json:"immediate,omitempty"`
}

// PriceTransition transitions the price for a subscription item
func (a *BillingAPI) PriceTransition(id string, params PriceTransitionParams) (*SubscriptionItem, error) {
	data, err := a.client.Post(fmt.Sprintf("/v1/billing/subscription_items/%s/price_transition", id), params)
	if err != nil {
		return nil, err
	}
	return ParseResponse[*SubscriptionItem](data)
}

// ListStatementsParams contains parameters for listing statements
type ListStatementsParams struct {
	Limit  int
	Offset int
}

// ListStatements retrieves all billing statements
func (a *BillingAPI) ListStatements(params ListStatementsParams) ([]Statement, int, error) {
	query := make(map[string]string)
	if params.Limit > 0 {
		query["limit"] = strconv.Itoa(params.Limit)
	}
	if params.Offset > 0 {
		query["offset"] = strconv.Itoa(params.Offset)
	}

	data, err := a.client.Get("/v1/billing/statements", query)
	if err != nil {
		return nil, 0, err
	}

	result, err := ParseListResponse[Statement](data)
	if err != nil {
		return nil, 0, err
	}

	return result.Data, result.TotalCount, nil
}

// GetStatement retrieves a specific statement by ID
func (a *BillingAPI) GetStatement(id string) (*Statement, error) {
	data, err := a.client.Get(fmt.Sprintf("/v1/billing/statements/%s", id), nil)
	if err != nil {
		return nil, err
	}
	return ParseResponse[*Statement](data)
}

// ListPaymentAttemptsParams contains parameters for listing payment attempts
type ListPaymentAttemptsParams struct {
	Limit  int
	Offset int
}

// ListPaymentAttempts retrieves payment attempts for a statement
func (a *BillingAPI) ListPaymentAttempts(statementID string, params ListPaymentAttemptsParams) ([]PaymentAttempt, int, error) {
	query := make(map[string]string)
	if params.Limit > 0 {
		query["limit"] = strconv.Itoa(params.Limit)
	}
	if params.Offset > 0 {
		query["offset"] = strconv.Itoa(params.Offset)
	}

	data, err := a.client.Get(fmt.Sprintf("/v1/billing/statements/%s/payment_attempts", statementID), query)
	if err != nil {
		return nil, 0, err
	}

	result, err := ParseListResponse[PaymentAttempt](data)
	if err != nil {
		return nil, 0, err
	}

	return result.Data, result.TotalCount, nil
}
