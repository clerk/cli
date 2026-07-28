# Does keyless config reach the running app?

The tapes in `../tapes/` show the CLI's side of a keyless workflow. These
screenshots show the other side: Clerk's own hosted Account Portal, rendering
from an application **nobody has claimed**, before and after the CLI changes its
configuration.

Every image is the live portal for an application minted through
`POST /v1/accountless_applications`. No account, no login, no dashboard visit.

## What each pair proves

| Screenshot                       | What it shows                                                                                                   |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `01-signin-before.png`           | The hosted sign-in page of a freshly minted keyless app — Google, email, password, straight out of the box      |
| `02-signup-before.png`           | Its sign-up page, unrestricted                                                                                  |
| `03-orgs-enabled-after.png`      | After `clerk enable orgs`: signing in now stops at a **Setup your organization** step that did not exist before |
| `04-orgs-disabled-after.png`     | After `clerk disable orgs`: the same URL redirects straight past it                                             |
| `05-signup-restricted-after.png` | After the CLI enables the allowlist: _"… is not allowed to access this application."_                           |
| `06-signup-allowed-after.png`    | After the CLI lifts it again: the identical sign-up advances to email verification                              |

The organization pair is the strongest of the three. Enabling organizations does
not merely set a flag — it inserts a step into the sign-in flow, and disabling it
removes that step. The shape of the authentication flow itself is being changed
from a terminal, on an application that has never been claimed.

## Two kinds of proof, because there are two kinds of setting

The unauthenticated Frontend API environment is what Clerk's UI components render
from, so for anything the UI _draws_ it is the machine-readable oracle:

```sh
curl -s "https://<frontend-api-host>/v1/environment?__clerk_api_version=2025-04-10&_clerk_js_version=5.100.0"
```

`clerk enable orgs` moves `organization_settings.enabled` there from `false` to
`true`, which is why the sign-in step appears.

Restrictions are different, and the difference is worth knowing before you go
looking for it in the wrong place. Enabling the allowlist leaves
`user_settings.sign_up.mode` reading `public` — that field describes what the
sign-up form should _render_, and the form still renders. The rule is enforced
when the sign-up is submitted. So the only honest proof for a restriction is to
attempt the operation and be refused, which is what `05` and `06` capture.

## Re-creating these

They were captured against a throwaway application whose keys are long gone;
the URLs in them will not resolve. To reproduce, mint your own and drive the
portal at the `accounts_portal_url` from:

```sh
clerk api /domains          # works with only an instance secret key
```

Nothing needs cleaning up. Unclaimed applications are throwaway by construction.
