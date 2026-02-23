import { select, input, confirm, password } from "@inquirer/prompts";

export async function deploy(options: { debug?: boolean }) {
  const debug = options.debug ? (...args: unknown[]) => console.log("[debug]", ...args) : () => {};

  console.log("\x1b[33m[mock] This command uses mocked data and is not yet wired up to real APIs.\x1b[0m\n");

  debug("Checking for authenticated user and linked application...");

  // Mock state — will be replaced with real lookups
  const user = { id: "user_abc123", email: "kyle@clerk.dev" };
  const application = { id: "app_xyz789", name: "my-saas-app" };

  debug(`Found authenticated user: ${user.email} (${user.id})`);
  debug(`Found linked application: ${application.name} (${application.id})`);

  // Mock state — no production instance exists yet
  debug("Checking for production instance...");
  const productionInstance = null;

  debug("No production instance found.");

  // Mock state — check subscription vs dev instance features
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

  const domainChoice = await select({
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
    domain = await input({
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

    // Mock state — DNS lookup and Domain Connect check
    const dnsProvider = { name: "Cloudflare", supportsDomainConnect: true };
    debug(`DNS hosted by: ${dnsProvider.name}`);
    debug(`Checking Domain Connect support for ${dnsProvider.name}...`);
    debug(`${dnsProvider.name} supports Domain Connect.`);

    const domainConnectUrl = `https://domainconnect.${dnsProvider.name.toLowerCase()}.com/v2/domainTemplates/providers/clerk.com/services/clerk-production/apply?domain=${domain}`;
    debug(`Composed Domain Connect URL: ${domainConnectUrl}`);

    await confirm({
      message: `We can automatically configure DNS for ${domain} via ${dnsProvider.name}. Open browser to continue?`,
      default: true,
    });

    debug("Opening Domain Connect flow in browser...");
  }

  // Check dev instance settings that require production credentials
  debug("Checking development instance settings for production requirements...");

  // Mock state — dev instance has Google OAuth enabled
  const devSettings = {
    socialProviders: ["google"],
  };

  if (devSettings.socialProviders.length > 0) {
    debug(`Found social providers requiring production credentials: ${devSettings.socialProviders.join(", ")}`);

    for (const provider of devSettings.socialProviders) {
      const displayName = provider.charAt(0).toUpperCase() + provider.slice(1);
      const docsUrl = `https://clerk.com/docs/guides/configure/auth-strategies/social-connections/${provider}#configure-for-your-production-instance`;

      const credentialChoice = await select({
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
        const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
        const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
        const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

        console.log(`\n${bold(`When configuring your ${displayName} OAuth app, use these values:`)}\n`);
        console.log(`  ${dim("Authorized JavaScript origins:")}`);
        console.log(`    ${cyan(`https://${domain}`)}`);
        console.log(`    ${cyan(`https://www.${domain}`)}`);
        console.log(`\n  ${dim("Authorized redirect URI:")}`);
        console.log(`    ${cyan(`https://accounts.${domain}/v1/oauth_callback`)}`);
        console.log();

        debug(`Opening ${displayName} OAuth setup guide in browser...`);
        const proc = Bun.spawn(["open", docsUrl]);
        await proc.exited;

        console.log("Once you've created your credentials, enter them below:\n");
      }

      const clientId = await input({
        message: `${displayName} OAuth Client ID:`,
      });

      const clientSecret = await password({
        message: `${displayName} OAuth Client Secret:`,
      });

      debug(`Received ${displayName} credentials (client ID: ${clientId.slice(0, 8)}...)`);
    }

    debug("All social provider credentials collected.");
  }

  debug("Deploy complete.");

  console.log(`\n\x1b[1m\x1b[32mYour production application is set up and ready at \x1b[34mhttps://${domain}\x1b[0m`);
  console.log(`\x1b[2mIf your application is not loading correctly, you may need to redeploy with your updated Clerk secret keys.\x1b[0m`);
}
