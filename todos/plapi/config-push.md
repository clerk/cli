# PLAPI: Instance Config Push Endpoints

Status: **Proposed** — no backend implementation yet. This documents the endpoints the CLI expects.

## Resource

```
/v1/platform/applications/{applicationId}/instances/{instanceId}/config
```

This resource already supports `GET` (used by `clerk config pull`). We propose adding `PUT` and `PATCH`.

## Authentication

All requests require a Bearer token via the `Authorization` header:

```
Authorization: Bearer <CLERK_PLATFORM_API_KEY>
```

---

## PUT — Replace Entire Config

Replaces the full instance configuration. Any fields not present in the request body are removed.

### Request

```
PUT /v1/platform/applications/{applicationId}/instances/{instanceId}/config
Content-Type: application/json
Authorization: Bearer <token>
```

```json
{
  "session": { "lifetime": 3600 },
  "sign_up": { "mode": "restricted" }
}
```

### Response — 200 OK

Returns the full config as it exists after replacement.

```json
{
  "session": { "lifetime": 3600 },
  "sign_up": { "mode": "restricted" }
}
```

---

## PATCH — Partial Config Update

Updates specific fields via deep merge. Fields not included in the request body are left unchanged. Nested objects are merged recursively — sending `{"session": {"lifetime": 3600}}` updates `session.lifetime` without touching other `session` fields or any other top-level keys.

### Request

```
PATCH /v1/platform/applications/{applicationId}/instances/{instanceId}/config
Content-Type: application/json
Authorization: Bearer <token>
```

```json
{
  "session": { "lifetime": 3600 }
}
```

### Response — 200 OK

Returns the full config as it exists after the merge.

```json
{
  "session": { "lifetime": 3600, "token_format": "jwt" },
  "sign_up": { "mode": "public" }
}
```

---

## Error Responses

All error responses use a consistent shape:

```json
{
  "errors": [
    {
      "code": "invalid_config",
      "message": "session.lifetime must be a positive integer"
    }
  ]
}
```

### Status Codes

| Status | Meaning |
|--------|---------|
| 200 | Success — config updated, full resulting config returned |
| 400 | Invalid JSON or malformed request body |
| 401 | Missing or invalid API key |
| 404 | Application or instance not found |
| 422 | Valid JSON but logically invalid config (e.g., incompatible settings, unknown keys) |

---

## Field Deletion (PATCH)

To explicitly remove a field during a PATCH, set its value to `null`:

```json
{
  "sign_up": null
}
```

This removes the `sign_up` key entirely from the config. Omitting a key leaves it unchanged (the default PATCH behavior).

---

## Notes

- Both PUT and PATCH return the full resulting config, so the CLI can display the final state to the user.
- The config schema is not defined here — it varies by Clerk version and instance type. The API is responsible for schema validation and returns 422 for invalid configs.
- Rate limiting and idempotency behavior should follow existing PLAPI conventions.
