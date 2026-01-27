package api

import (
	"encoding/json"
	"fmt"
)

// Rules

type Rule struct {
	ID          string `json:"id"`
	Expression  string `json:"expression"`
	Action      string `json:"action"`
	Description string `json:"description,omitempty"`
	Position    int    `json:"position"`
	CreatedAt   int64  `json:"created_at,omitempty"`
	UpdatedAt   int64  `json:"updated_at,omitempty"`
}

type RulesResponse struct {
	Rules         []Rule  `json:"rules"`
	NextPageToken *string `json:"nextPageToken,omitempty"`
}

// Schema

type SchemaResponse struct {
	EventTypes map[string]EventTypeSchema `json:"eventTypes"`
}

type EventTypeSchema struct {
	Fields map[string]SchemaField `json:"fields"`
}

type Schema struct {
	EventType string                 `json:"event_type"`
	Fields    map[string]SchemaField `json:"fields"`
}

type SchemaField struct {
	Type        string                 `json:"type"`
	Description string                 `json:"description,omitempty"`
	Fields      map[string]SchemaField `json:"fields,omitempty"`
	Items       *SchemaField           `json:"items,omitempty"`
}

type ProtectAPI struct {
	client *Client
}

func NewProtectAPI(client *Client) *ProtectAPI {
	return &ProtectAPI{client: client}
}

// Rules methods

func (a *ProtectAPI) ListRules(ruleset string) ([]Rule, string, error) {
	data, meta, err := a.client.RequestWithMeta("GET", fmt.Sprintf("/v1/protect/rulesets/%s/rules", ruleset), nil)
	if err != nil {
		return nil, "", err
	}

	result, err := ParseResponse[RulesResponse](data)
	if err != nil {
		return nil, "", err
	}

	etag := ""
	if meta != nil {
		etag = meta.ETag
	}

	return result.Rules, etag, nil
}

func (a *ProtectAPI) GetRule(ruleset, id string) (*Rule, error) {
	// The API doesn't support fetching individual rules, so we list and filter
	rules, _, err := a.ListRules(ruleset)
	if err != nil {
		return nil, err
	}

	for _, rule := range rules {
		if rule.ID == id {
			return &rule, nil
		}
	}

	return nil, fmt.Errorf("rule not found: %s", id)
}

type CreateRuleParams struct {
	Expression  string `json:"expression"`
	Action      string `json:"action"`
	Description string `json:"description,omitempty"`
	Position    *int   `json:"position,omitempty"`
}

func (a *ProtectAPI) CreateRule(ruleset string, params CreateRuleParams) (*Rule, error) {
	data, err := a.client.Post(fmt.Sprintf("/v1/protect/rulesets/%s/rules", ruleset), params)
	if err != nil {
		return nil, err
	}
	return ParseResponse[*Rule](data)
}

type UpdateRuleParams struct {
	Expression  string `json:"expression,omitempty"`
	Action      string `json:"action,omitempty"`
	Description string `json:"description,omitempty"`
	Position    *int   `json:"position,omitempty"`
}

func (a *ProtectAPI) UpdateRule(ruleset, id string, params UpdateRuleParams) (*Rule, error) {
	data, err := a.client.Put(fmt.Sprintf("/v1/protect/rulesets/%s/rules/%s", ruleset, id), params)
	if err != nil {
		return nil, err
	}
	return ParseResponse[*Rule](data)
}

func (a *ProtectAPI) DeleteRule(ruleset, id string) error {
	_, err := a.client.Delete(fmt.Sprintf("/v1/protect/rulesets/%s/rules/%s", ruleset, id))
	return err
}

func (a *ProtectAPI) FlushRules(ruleset string) error {
	_, err := a.client.Delete(fmt.Sprintf("/v1/protect/rulesets/%s/rules", ruleset))
	return err
}

type ReorderRulesParams struct {
	RuleIDs []string `json:"rule_ids"`
}

func (a *ProtectAPI) ReorderRules(ruleset string, ruleIDs []string, etag string) error {
	_, err := a.client.Request("PATCH", fmt.Sprintf("/v1/protect/rulesets/%s", ruleset), &RequestOptions{
		Body:    ReorderRulesParams{RuleIDs: ruleIDs},
		IfMatch: etag,
	})
	return err
}

// Schema methods

func (a *ProtectAPI) GetFullSchema() (*SchemaResponse, error) {
	data, err := a.client.Get("/v1/protect/schema", nil)
	if err != nil {
		return nil, err
	}

	result := &SchemaResponse{
		EventTypes: make(map[string]EventTypeSchema),
	}

	// The response structure is:
	// { "events": { "SIGN_IN": { "name": "...", "fields": {...}, "type": {...}, "kind": "..." } } }
	var rawResponse struct {
		Events map[string]rawEventType `json:"events"`
	}
	if err := parseJSONInto(data, &rawResponse); err != nil {
		return nil, fmt.Errorf("failed to parse schema: %w", err)
	}

	for eventType, rawET := range rawResponse.Events {
		fields := extractFields(rawET.Fields)
		result.EventTypes[eventType] = EventTypeSchema{Fields: fields}
	}

	return result, nil
}

type rawEventType struct {
	Name   string                 `json:"name"`
	Fields map[string]interface{} `json:"fields"`
	Kind   string                 `json:"kind"`
}

func extractFields(raw map[string]interface{}) map[string]SchemaField {
	fields := make(map[string]SchemaField)
	for name, value := range raw {
		fields[name] = extractField(value)
	}
	return fields
}

func extractField(value interface{}) SchemaField {
	v, ok := value.(map[string]interface{})
	if !ok {
		return SchemaField{Type: fmt.Sprintf("%v", value)}
	}

	field := SchemaField{}

	// Get the type - it might be a string or a nested object with a "type" field
	if typeVal, ok := v["type"]; ok {
		switch t := typeVal.(type) {
		case string:
			field.Type = t
		case map[string]interface{}:
			if typeStr, ok := t["type"].(string); ok {
				field.Type = typeStr
			} else {
				field.Type = "struct"
			}
		}
	}

	// If there's a "kind" field, use it to determine if this is a builtin/struct
	if kind, ok := v["kind"].(string); ok && kind == "builtin" && field.Type == "" {
		field.Type = "struct"
	}

	// Get nested fields if present
	if nestedFields, ok := v["fields"].(map[string]interface{}); ok {
		field.Fields = extractFields(nestedFields)
		if field.Type == "" {
			field.Type = "struct"
		}
	}

	// Get description if present
	if desc, ok := v["description"].(string); ok {
		field.Description = desc
	}

	// Default type if not set
	if field.Type == "" {
		field.Type = "unknown"
	}

	return field
}

func parseJSONInto(data []byte, v interface{}) error {
	return json.Unmarshal(data, v)
}

func (a *ProtectAPI) GetSchema(eventType string) (*Schema, error) {
	fullSchema, err := a.GetFullSchema()
	if err != nil {
		return nil, err
	}

	// If eventType is empty or ALL, return all event types as fields
	if eventType == "" || eventType == "ALL" {
		// Return each event type as a top-level field
		allFields := make(map[string]SchemaField)
		for etName, etSchema := range fullSchema.EventTypes {
			allFields[etName] = SchemaField{
				Type:   "struct",
				Fields: etSchema.Fields,
			}
		}
		return &Schema{
			EventType: "ALL",
			Fields:    allFields,
		}, nil
	}

	// Look for specific event type
	if etSchema, ok := fullSchema.EventTypes[eventType]; ok {
		return &Schema{
			EventType: eventType,
			Fields:    etSchema.Fields,
		}, nil
	}

	// Build list of available event types for error message
	available := make([]string, 0, len(fullSchema.EventTypes))
	for etName := range fullSchema.EventTypes {
		available = append(available, etName)
	}

	return nil, fmt.Errorf("unknown event type: %s (available: %v)", eventType, available)
}

func (a *ProtectAPI) GetEventTypes() ([]string, error) {
	fullSchema, err := a.GetFullSchema()
	if err != nil {
		return nil, err
	}

	types := make([]string, 0, len(fullSchema.EventTypes)+1)
	types = append(types, "ALL")
	for eventType := range fullSchema.EventTypes {
		types = append(types, eventType)
	}
	return types, nil
}

var EventTypes = []string{"ALL", "SIGN_IN", "SIGN_UP", "SMS", "EMAIL"}
