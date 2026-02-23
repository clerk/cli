# Env Pull Command

Pulls Clerk API keys for the linked instance and merges them into the project's `.env` file.

## Usage

```
clerk env pull [--instance dev|prod|<instance_id>] [--file <path>]
```

### Options

| Option | Description |
|---|---|
| `--instance <id>` | Instance to target (`dev`, `prod`, or a full instance ID) |
| `--file <path>` | Target env file (default: auto-detect) |

## Sequence Diagram

```mermaid
sequenceDiagram
    actor User
    participant CLI as Clerk CLI
    participant API as Clerk Platform API
    participant FS as File System

    Note over CLI: clerk env pull [--instance dev|prod] [--file .env]

    %% Resolve project profile
    CLI->>FS: Read ~/.clerk/config.json
    FS-->>CLI: { appId, instances }

    %% Fetch application with keys
    CLI->>API: GET /v1/platform/applications/{appId}
    API-->>CLI: { instances: [{ instance_id, publishable_key, secret_key }] }
    CLI->>CLI: Find matching instance by instance_id

    %% Detect framework
    CLI->>FS: Read package.json
    FS-->>CLI: { dependencies }
    CLI->>CLI: Map framework → publishable key env var name

    %% Resolve target file
    alt --file flag provided
        CLI->>CLI: Use specified file
    else .env.local exists
        CLI->>FS: Check .env.local
        FS-->>CLI: exists
    else .env exists
        CLI->>FS: Check .env
        FS-->>CLI: exists
    else No env file
        CLI->>CLI: Default to .env.local
    end

    %% Read, merge, write
    CLI->>FS: Read target file (or empty)
    CLI->>CLI: Parse → Merge (in-place update or append) → Serialize
    CLI->>FS: Write updated file
    CLI->>User: Environment variables written to .env.local
```

## API Endpoints

| Step | Method | Endpoint | Notes |
|---|---|---|---|
| Auth | — | Local config | Token from `CLERK_PLATFORM_API_KEY` env var |
| Fetch application | `GET` | `/v1/platform/applications/{appId}` | Returns all instances with keys |

## Framework Detection

Reads `package.json` dependencies to determine the correct publishable key env var name:

| Framework dependency | Env var name |
|---|---|
| `next` | `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` |
| `expo` | `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` |
| `astro` | `PUBLIC_CLERK_PUBLISHABLE_KEY` |
| `nuxt` | `NUXT_PUBLIC_CLERK_PUBLISHABLE_KEY` |
| `vite` | `VITE_CLERK_PUBLISHABLE_KEY` |
| fallback | `CLERK_PUBLISHABLE_KEY` |

Priority is top-to-bottom (e.g., a Next.js project that also has Vite will use `NEXT_PUBLIC_*`).

## .env Merge Behavior

- Existing Clerk keys are updated **in-place**, preserving their position in the file
- New keys are appended at the end with a `# Clerk` section header
- Comments, blank lines, and non-Clerk keys are preserved exactly as-is
- File always ends with a trailing newline
