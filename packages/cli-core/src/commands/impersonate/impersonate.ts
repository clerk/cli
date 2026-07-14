import { bold, cyan, dim } from "../../lib/color.ts";
import { createActorToken } from "../../lib/actor-tokens.ts";
import {
  BapiError,
  BILLING_ERROR_REASON,
  BillingError,
  CliError,
  ERROR_CODE,
  throwUserAbort,
  withApiContext,
} from "../../lib/errors.ts";
import { getDashboardUrl } from "../../lib/environment.ts";
import { log } from "../../lib/log.ts";
import { openBrowser } from "../../lib/open.ts";
import { confirm } from "../../lib/prompts.ts";
import { withSpinner } from "../../lib/spinner.ts";
import { isAgent, isHuman } from "../../mode.ts";
import {
  resolveUsersInstanceContext,
  type UsersInstanceContext,
} from "../users/interactive/instance-context.ts";
import { buildActorStamp, requireLoginEmail } from "./actor.ts";
import { resolveImpersonationTarget } from "./resolve-user.ts";

export type ImpersonateOptions = {
  user?: string;
  secretKey?: string;
  app?: string;
  instance?: string;
  actor?: string;
  expiresIn?: number;
  open?: boolean;
  print?: boolean;
  yes?: boolean;
};

const DEFAULT_EXPIRES_IN_SECONDS = 3600;

function isProductionInstance(ctx: UsersInstanceContext): boolean {
  if (ctx.instanceLabel) return ctx.instanceLabel === "production";
  return ctx.secretKey.startsWith("sk_live_");
}

async function openOrWarn(url: string): Promise<void> {
  const result = await openBrowser(url);
  if (!result.ok) {
    log.warn(
      `Could not open your browser automatically. Open this URL to continue:\n  ${cyan(url)}\n${dim(`(Reason: ${result.reason})`)}`,
    );
  }
}

// The impersonation add-on is bought per account, not per app/instance, so this
// is deliberately the account-level billing page, not the per-instance dashboard path.
function impersonationBillingUrl(): string {
  return `${getDashboardUrl().replace(/\/$/, "")}/settings/billing`;
}

function actorTokenErrorToCliError(error: unknown): CliError | undefined {
  if (!(error instanceof BapiError)) return undefined;

  if (error.status === 402) {
    return new BillingError("Impersonation is available as an add-on.", {
      reason: BILLING_ERROR_REASON.PLAN_NOT_ENABLED,
      code: ERROR_CODE.IMPERSONATION_NOT_ENABLED,
      docsUrl: impersonationBillingUrl(),
    });
  }

  if (error.status === 422) {
    return new BillingError("You've reached your impersonation limit this billing period.", {
      reason: BILLING_ERROR_REASON.QUOTA_EXCEEDED,
      code: ERROR_CODE.IMPERSONATION_LIMIT_EXCEEDED,
      docsUrl: impersonationBillingUrl(),
    });
  }

  return undefined;
}

// The session was never created, so the caller still rethrows to exit non-zero
// after this — nudging only decides whether to actively open the billing page.
// Agent, --print, and non-TTY stay passive: the global handler already surfaces
// the URL, and we can't assume consent to open without a prompt or --yes.
async function nudgeToBilling(error: BillingError, options: ImpersonateOptions): Promise<void> {
  const url = error.docsUrl;
  if (!url || isAgent() || options.print) return;

  if (options.yes) {
    await openOrWarn(url);
    return;
  }

  if (!process.stdin.isTTY) return;

  const upgrade = await confirm({ message: "Add more impersonations now?", default: true });
  if (upgrade) {
    await openOrWarn(url);
  }
}

export async function impersonate(options: ImpersonateOptions = {}): Promise<void> {
  const loginEmail = await requireLoginEmail();

  const ctx = await resolveUsersInstanceContext({
    secretKey: options.secretKey,
    app: options.app,
    instance: options.instance,
  });

  const userId = await resolveImpersonationTarget(options.user, ctx);
  const expiresIn = options.expiresIn ?? DEFAULT_EXPIRES_IN_SECONDS;
  const actor = buildActorStamp(loginEmail, options.actor);

  const appLabel = ctx.appLabel ?? ctx.appId ?? "this application";
  const instanceLabel = ctx.instanceLabel ?? ctx.instanceId ?? "this instance";

  if (!options.yes && isHuman()) {
    if (isProductionInstance(ctx)) {
      log.warn(
        "production — signs you in as this user and bypasses their MFA. may count against your monthly impersonation quota.",
      );
    }
    const proceed = await confirm({
      message: `Impersonate ${cyan(userId)} on ${bold(appLabel)} (${instanceLabel})?`,
      default: false,
    });
    if (!proceed) {
      throwUserAbort();
    }
  }

  let token;
  try {
    token = await withApiContext(
      withSpinner("Creating impersonation session...", () =>
        createActorToken(ctx.secretKey, {
          userId,
          actor: { sub: actor.sub, iss: actor.iss },
          expiresInSeconds: expiresIn,
        }),
      ),
      "Failed to create impersonation session",
    );
  } catch (error) {
    const cliError = actorTokenErrorToCliError(error);
    if (cliError instanceof BillingError) {
      await nudgeToBilling(cliError, options);
      throw cliError;
    }
    if (cliError) throw cliError;
    throw error;
  }

  if (isAgent()) {
    log.data(
      JSON.stringify({
        url: token.url,
        id: token.id,
        userId,
        actor: { sub: actor.sub, iss: actor.iss },
        appId: ctx.appId,
        appLabel: ctx.appLabel,
        instanceId: ctx.instanceId,
        instanceLabel: ctx.instanceLabel,
        expiresInSeconds: expiresIn,
      }),
    );
    return;
  }

  // Always print the URL verbatim first, regardless of what happens next —
  // if --print/--open are both passed, --print wins (never opens).
  log.data(token.url);
  // BAPI has no list endpoint for actor tokens, so this is the only moment a
  // human can learn the ID needed to revoke. Pin the same app/instance the
  // token was created on so the hint can't resolve a different target, and
  // include --user so the command still works after the token is accepted
  // (revoking then falls back to ending the impersonation session).
  const revokeTarget = [
    ` --user ${userId}`,
    ctx.appId ? ` --app ${ctx.appId}` : "",
    ctx.instanceId ? ` --instance ${ctx.instanceId}` : "",
  ].join("");
  log.info(dim(`Revoke with: clerk imp revoke ${token.id}${revokeTarget}`));

  if (options.print) {
    return;
  }

  if (options.open) {
    await openOrWarn(token.url);
    return;
  }

  if (!process.stdin.isTTY) {
    return;
  }

  const shouldOpen = await confirm({
    message: "Press Enter to open in your browser (Ctrl+C to skip)",
    default: true,
  });
  if (shouldOpen) {
    await openOrWarn(token.url);
  }
}
