import { select, input, confirm, password } from "@inquirer/prompts";
import { isAgent } from "../../mode.js";
import { dim, bold, cyan, green, blue, yellow } from "../../lib/color.js";
import { createCommandOutput } from "../../lib/cli.js";
import { getToken } from "../../lib/credential-store.js";
import { resolveProfile } from "../../lib/config.js";

export async function deploy(options: { debug?: boolean }) {
  using out = createCommandOutput("deploy");

  const debug = options.debug ? (...args: unknown[]) => console.log("[debug]", ...args) : () => {};

  // Pre-flight: auth + link
  const token = await getToken();
  out.add("authenticated", !!token, token ? "Logged in" : "Not authenticated", "clerk auth login");
  if (!token) return;

  const profile = await resolveProfile(process.cwd());
  out.add(
    "linked",
    !!profile,
    profile ? `Linked to ${profile.profile.appId}` : "Not linked",
    "clerk link",
  );
  if (!profile) return;

  if (isAgent()) {
    // Agent mode: report pre-flight status only — the deploy wizard requires interactive input
    out.add("subscription", true, "Check subscription compatibility before deploying");
    out.add("production_instance", false, "No production instance configured");
    out.suggest("clerk deploy (run interactively to complete setup)");
    return;
  }

  // ── Human interactive flow ───────────────────────────────────────────────

  console.log(
    yellow("  [mock] This command uses mocked data and is not yet wired up to real APIs.") + "\n",
  );

  debug("Checking for authenticated user and linked application...");

  // Mock state — will be replaced with real lookups
  const user = { id: "user_abc123", email: "kyle@clerk.dev" };
  const application = { id: "app_xyz789", name: "my-saas-app" };

  debug(`Found authenticated user: ${user.email} (${user.id})`);
  debug(`Found linked application: ${application.name} (${application.id})`);

  debug("Checking for production instance...");
  debug("No production instance found.");

  // Mock state — check subscription vs dev instance features
  debug("Checking development instance features against subscription...");
  const devFeatures = ["email_auth", "social_oauth"];
  const subscriptionFeatures = ["email_auth", "social_oauth"];
  const unsupported = devFeatures.filter((f) => !subscriptionFeatures.includes(f));

  if (unsupported.length > 0) {
    debug(`Found features not covered by subscription: ${unsupported.join(", ")}`);
    out.add("subscription", false, `Features not covered: ${unsupported.join(", ")}`);
    return;
  }

  out.add("subscription", true, "All dev features covered by plan");

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

  out.add("domain", true, `Production domain: ${domain}`);

  // Check dev instance settings that require production credentials
  debug("Checking development instance settings for production requirements...");

  // Mock state — dev instance has Google OAuth enabled
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
        console.log(
          `\n${bold(`When configuring your ${displayName} OAuth app, use these values:`)}\n`,
        );
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

      await password({
        message: `${displayName} OAuth Client Secret:`,
      });

      debug(`Received ${displayName} credentials (client ID: ${clientId.slice(0, 8)}...)`);
    }

    out.add("oauth_credentials", true, "All provider credentials configured");
  }

  debug("Deploy complete.");

  out.add("deployed", true, `Ready at https://${domain}`);

  console.log(
    `\n${bold(green(`Your production application is set up and ready at ${blue(`https://${domain}`)}`))}`,
  );
  console.log(
    dim(
      "If your application is not loading correctly, you may need to redeploy with your updated Clerk secret keys.",
    ),
  );
}
