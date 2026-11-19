---
"clerk": minor
---

Let `clerk deploy` use a free `<name>.clerk.app` domain for apps that can, with `--clerk-app <name>` to skip the prompts. A hosting domain such as `acme.vercel.app`, typed at the prompt or passed as `--domain`, gives production a free clerk.app domain named after it, as the Clerk Dashboard does, and adds `acme.vercel.app` beside it as a hosting domain with its proxy setup. `clerk deploy add-domain <domain>` adds a domain you own, such as `acme.com`, and prints its DNS records, or your app's domain on a hosting provider, such as `acme.vercel.app`, and prints the Clerk proxy setup. `clerk deploy use-domain <domain>` makes an added domain you own the primary domain once it is ready. `clerk deploy domains` lists production's domains. Once a domain you own is primary, `clerk deploy remove-domain <name>.clerk.app` shuts down the clerk.app domain; other domains of an app on clerk.app can't be removed.
