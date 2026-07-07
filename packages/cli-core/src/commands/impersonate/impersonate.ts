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

function actorTokenErrorToCliError(error: unknown): CliError | undefined {
  if (!(error instanceof BapiError)) return undefined;

  if (error.status === 402) {
    return new BillingError("Impersonation isn't enabled on this app's plan.", {
      reason: BILLING_ERROR_REASON.PLAN_NOT_ENABLED,
      code: ERROR_CODE.IMPERSONATION_NOT_ENABLED,
    });
  }

  if (error.status === 422) {
    const meta = error.meta ?? {};
    const limit = typeof meta.limit === "number" ? meta.limit : undefined;
    const used = typeof meta.used === "number" ? meta.used : undefined;
    const quota =
      limit !== undefined && used !== undefined
        ? ` (used ${used}/${limit} this billing period)`
        : "";
    return new BillingError(`Impersonation limit exceeded${quota}.`, {
      reason: BILLING_ERROR_REASON.QUOTA_EXCEEDED,
      code: ERROR_CODE.IMPERSONATION_LIMIT_EXCEEDED,
      limit,
      used,
    });
  }

  return undefined;
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
  // human can learn the ID needed to revoke.
  log.info(dim(`Revoke with: clerk imp revoke ${token.id}`));

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
