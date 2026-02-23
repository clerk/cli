# Whoami Command

Displays the email address of the currently authenticated user.

## Usage

```sh
clerk whoami
```

## Behavior

- Reads the stored authentication token from the local credential store
- Fetches user info from the Clerk API and prints the user's email
- If no token exists, prints a message to run `clerk auth login`
- If the token is expired or invalid, prints a session expired message

## API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/oauth/userinfo` | Fetches the user's `email` and `sub` (user ID) using the stored access token. Base URL defaults to `https://clerk.clerk.com`. |
