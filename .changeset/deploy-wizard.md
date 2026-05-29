---
"clerk": minor
---

Add `clerk deploy`, an interactive wizard that promotes a Clerk application from development to production.

- Walks through cloning the development instance, creating the production instance, and configuring CNAME records.
- Verifies mail, DNS, and SSL one component at a time so each step's status is visible while polling.
- Optionally exports the DNS records as a BIND zone file at `./clerk-<domain>.zone` for import into providers like Cloudflare, Route 53, and Google Cloud DNS.
- Resumes from the next pending step on subsequent runs, including reshowing the CNAME records when DNS is not yet verified.
- Uses provider schemas to collect production OAuth credentials for broader built-in provider support.
- Lets Google OAuth setup load the downloaded credentials JSON after opening the provider docs.
