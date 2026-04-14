import type { Need } from "../../lib/deps.ts";
import { dim, bold, cyan, green, blue, yellow } from "../../lib/color.ts";
import { printNextSteps, NEXT_STEPS } from "../../lib/next-steps.ts";

export type DeployDeps = Need<{
  mode: "isAgent";
  prompts: "select" | "input" | "confirm" | "password";
  browser: "open";
  log: "info" | "debug" | "data" | "blank";
}>;

export interface DeployOptions {
  debug?: boolean;
}

const DEPLOY_PROMPT = `You are deploying a Clerk application to production. Follow these steps:

## Prerequisites

Ensure the following before starting:
- The user is authenticated (\`clerk auth login\` has been run)
- A Clerk application is linked to the project (\`clerk link\` has been run)
- The project has a development instance with a working configuration

## Step 1: Verify Subscription Compatibility

Check that the development instance's features are covered by the application's subscription plan.

- Fetch the development config: \`GET /v1/platform/applications/{appID}/instances/development/config\`
- Fetch the subscription: \`GET /v1/platform/applications/{appID}/subscription\`
- If any development features are not covered by the plan, the user must upgrade before deploying.

## Step 2: Choose a Production Domain

Ask the user which domain setup they prefer:

**Option A: Custom domain**
- The user provides their own domain (e.g., example.com)
- DNS must be configured to point to Clerk. Check if the DNS provider supports Domain Connect for automatic setup.
- If Domain Connect is available, direct the user to the Domain Connect URL to authorize DNS changes.
- If not, provide the DNS records the user must add manually.
- Verify DNS propagation: \`POST /v1/platform/applications/{appID}/domains/{domainID}/dns_check\`

**Option B: Clerk-provided subdomain**
- A subdomain like \`{adjective}-{animal}-{number}.clerk.app\` is automatically assigned.
- No DNS configuration is needed.

## Step 3: Create the Production Instance

Create or configure the production instance for the application.
- Add the domain: \`POST /v1/platform/applications/{appID}/domains\` with body \`{ "name": "<domain>", "is_satellite": false }\`
- Note: There is currently no dedicated endpoint to add a production instance to an existing app. This may require \`POST /v1/platform/applications\` with \`environment_types: ["development", "production"]\`.

## Step 4: Configure Social OAuth Providers

For each social provider enabled in the development instance (e.g., Google, GitHub, Apple), production OAuth credentials are required.

Check the dev config for \`connection_oauth_*\` keys. For each enabled provider:

1. Collect the required credentials from the user:
   - Most providers: \`client_id\` and \`client_secret\`
   - Apple: also requires \`key_id\` and \`team_id\`

2. When helping the user create OAuth credentials, provide these values:
   - Authorized JavaScript origins: \`https://{domain}\` and \`https://www.{domain}\`
   - Authorized redirect URI: \`https://accounts.{domain}/v1/oauth_callback\`

3. Write credentials to production config:
   \`PATCH /v1/platform/applications/{appID}/instances/production/config\`
   Body: \`{ "connection_oauth_{provider}": { "enabled": true, "client_id": "...", "client_secret": "..." } }\`

Provider-specific documentation: https://clerk.com/docs/guides/configure/auth-strategies/social-connections/{provider}

## Step 5: Finalize

After all configuration is complete:
- Inform the user their production application is ready at \`https://{domain}\`
- Remind them to redeploy their application with the updated Clerk production secret keys
- They can pull production keys with: \`clerk env pull --instance prod\`

## API Reference

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | /v1/platform/applications/{appID} | Fetch application details |
| GET | .../instances/development/config | Read dev instance config and enabled features |
| GET | .../instances/production/config | Check if production instance exists (404 if not) |
| GET | .../subscription | Check subscription plan |
| POST | /v1/platform/applications | Create application with production instance |
| POST | .../domains | Add a custom domain |
| POST | .../domains/{domainID}/dns_check | Trigger DNS verification |
| PATCH | .../instances/production/config | Write OAuth credentials to production |

Refer to the Clerk Platform API docs for detailed request/response schemas.`;

export async function deploy(deps: DeployDeps, options: DeployOptions): Promise<void> {
  if (deps.mode.isAgent()) {
    deps.log.data(DEPLOY_PROMPT);
    return;
  }
  const debug = options.debug
    ? (...args: unknown[]) => deps.log.debug(["[debug]", ...args].map((a) => String(a)).join(" "))
    : () => {};

  deps.log.info(
    yellow("[mock] This command uses mocked data and is not yet wired up to real APIs.") + "\n",
  );

  debug("Checking for authenticated user and linked application...");

  // Mock state, will be replaced with real lookups
  const user = { id: "user_abc123", email: "kyle@clerk.dev" };
  const application = { id: "app_xyz789", name: "my-saas-app" };

  debug(`Found authenticated user: ${user.email} (${user.id})`);
  debug(`Found linked application: ${application.name} (${application.id})`);

  debug("Checking for production instance...");
  debug("No production instance found.");

  // Mock state, check subscription vs dev instance features
  debug("Checking development instance features against subscription...");
  const devFeatures = ["email_auth", "social_oauth"];
  const subscriptionFeatures = ["email_auth", "social_oauth"];
  const unsupported = devFeatures.filter((f) => !subscriptionFeatures.includes(f));

  if (unsupported.length > 0) {
    debug(`Found features not covered by subscription: ${unsupported.join(", ")}`);
    debug("User must upgrade their plan before deploying.");
    return;
  }

  debug("All development features are covered by subscription.");

  const domainChoice = await deps.prompts.select<"custom-domain" | "clerk-subdomain">({
    message: "How would you like to set up your production domain?",
    choices: [
      {
        name: "Use my own domain",
        value: "custom-domain",
      },
      {
        name: "Use a Clerk-provided subdomain",
        value: "clerk-subdomain",
      },
    ],
  });

  let domain: string;

  if (domainChoice === "custom-domain") {
    domain = await deps.prompts.input({
      message: "Enter your domain:",
    });
    debug(`User provided custom domain: ${domain}`);
  } else {
    // Mock generated subdomain
    const generatedSubdomain = "sincere-chinchilla-87.clerk.app";
    domain = generatedSubdomain;
    debug(`Using Clerk-provided subdomain: ${domain}`);
  }

  debug("Creating production instance...");
  debug(`Production instance created with domain: ${domain}`);

  // DNS setup for custom domains
  if (domainChoice === "custom-domain") {
    debug(`Looking up DNS provider for ${domain}...`);

    // Mock state, DNS lookup and Domain Connect check
    const dnsProvider = { name: "Cloudflare", supportsDomainConnect: true };
    debug(`DNS hosted by: ${dnsProvider.name}`);
    debug(`Checking Domain Connect support for ${dnsProvider.name}...`);
    debug(`${dnsProvider.name} supports Domain Connect.`);

    const domainConnectUrl = `https://domainconnect.${dnsProvider.name.toLowerCase()}.com/v2/domainTemplates/providers/clerk.com/services/clerk-production/apply?domain=${domain}`;
    debug(`Composed Domain Connect URL: ${domainConnectUrl}`);

    await deps.prompts.confirm({
      message: `We can automatically configure DNS for ${domain} via ${dnsProvider.name}. Open browser to continue?`,
      default: true,
    });

    debug("Opening Domain Connect flow in browser...");
  }

  // Check dev instance settings that require production credentials
  debug("Checking development instance settings for production requirements...");

  // Mock state, dev instance has Google OAuth enabled
  const devSettings = {
    socialProviders: ["google"],
  };

  if (devSettings.socialProviders.length > 0) {
    debug(
      `Found social providers requiring production credentials: ${devSettings.socialProviders.join(", ")}`,
    );

    for (const provider of devSettings.socialProviders) {
      const displayName = provider.charAt(0).toUpperCase() + provider.slice(1);
      const docsUrl = `https://clerk.com/docs/guides/configure/auth-strategies/social-connections/${provider}#configure-for-your-production-instance`;

      const credentialChoice = await deps.prompts.select<"walkthrough" | "have-credentials">({
        message: `Your app uses ${displayName} OAuth. Do you have your production credentials?`,
        choices: [
          {
            name: "Walk me through setting it up",
            value: "walkthrough",
          },
          {
            name: "I already have my credentials",
            value: "have-credentials",
          },
        ],
      });

      if (credentialChoice === "walkthrough") {
        deps.log.info(
          `\n${bold(`When configuring your ${displayName} OAuth app, use these values:`)}\n`,
        );
        deps.log.info(`  ${dim("Authorized JavaScript origins:")}`);
        deps.log.info(`    ${cyan(`https://${domain}`)}`);
        deps.log.info(`    ${cyan(`https://www.${domain}`)}`);
        deps.log.info(`\n  ${dim("Authorized redirect URI:")}`);
        deps.log.info(`    ${cyan(`https://accounts.${domain}/v1/oauth_callback`)}`);
        deps.log.info("");

        debug(`Opening ${displayName} OAuth setup guide in browser...`);
        const openResult = await deps.browser.open(docsUrl);
        if (!openResult.ok) {
          deps.log.info(dim(`(Could not open browser automatically, visit ${docsUrl})`));
        }

        deps.log.info("Once you've created your credentials, enter them below:\n");
      }

      const clientId = await deps.prompts.input({
        message: `${displayName} OAuth Client ID:`,
      });

      await deps.prompts.password({
        message: `${displayName} OAuth Client Secret:`,
      });

      debug(`Received ${displayName} credentials (client ID: ${clientId.slice(0, 8)}...)`);
    }

    debug("All social provider credentials collected.");
  }

  debug("Deploy complete.");

  deps.log.info(
    `\n${bold(green(`Your production application is set up and ready at ${blue(`https://${domain}`)}`))}`,
  );
  deps.log.info(
    dim(
      "If your application is not loading correctly, you may need to redeploy with your updated Clerk secret keys.",
    ),
  );

  printNextSteps(deps, NEXT_STEPS.DEPLOY);
}
