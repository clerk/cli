/**
 * Which Clerk instance `migrate export clerk` reads *from*.
 *
 * Every other resolver in the CLI answers "where do I operate?" with the linked
 * project, silently. For an export that default is actively dangerous: the
 * linked instance is normally the migration's *destination*, so taking it
 * without asking is how a run ends up exporting an instance and importing it
 * straight back into itself.
 *
 * So the source is resolved in three tiers:
 *
 * 1. The user named the instance — `--secret-key`, `--app`, `--instance`, or
 *    an exported `CLERK_SECRET_KEY` — and it runs unquestioned. An exported
 *    key outranks the linked profile everywhere else in this CLI
 *    (`resolveBapiSecretKey`), and this command is not the one place that
 *    should differ.
 * 2. Anything the CLI resolved on the user's behalf (the linked project, a
 *    keyless app) is not taken silently: every instance on the account is
 *    offered, with the resolved application's instances first so "yes, that
 *    one" is still a single Enter.
 * 3. Nothing to resolve at all — no link, no key, no flags — falls back to the
 *    application picker `users list` uses, rather than failing on an unlinked
 *    directory. That one is `clerk link`'s, so it also offers "create a new
 *    application"; an empty application is never the right source, but the
 *    alternative here is an error, not a better list.
 */

import { fetchAppsTolerantly } from "../../../lib/app-picker.ts";
import { describeBapiTarget, resolveBapiSecretKey } from "../../../lib/bapi-command.ts";
import { resolveProfile } from "../../../lib/config.ts";
import {
  CliError,
  ERROR_CODE,
  isAuthError,
  throwUsageError,
  throwUserAbort,
} from "../../../lib/errors.ts";
import { search } from "../../../lib/listage.ts";
import type { Application, ApplicationInstance } from "../../../lib/plapi.ts";
import { confirm } from "../../../lib/prompts.ts";
import { isHuman } from "../../../mode.ts";
import { isAssumeYes } from "../lib/assume-yes.ts";
import { resolveUsersInstanceContext } from "../../users/interactive/instance-context.ts";

/** e.g. `Development instance`. Unknown environment types print as-is. */
function instanceLabel(instance: ApplicationInstance): string {
  const type = instance.environment_type;
  if (!type) return "instance";
  return `${type.charAt(0).toUpperCase()}${type.slice(1)} instance`;
}

export type ResolveClerkSourceOptions = {
  secretKey?: string;
  app?: string;
  instance?: string;
  cwd?: string;
  /** `--json` never prompts. */
  json?: boolean;
};

export type ClerkExportSource = {
  secretKey: string;
  /**
   * Human-readable target, e.g. `my-app (production)`. Absent when
   * `--secret-key` (or `CLERK_SECRET_KEY`) named the instance directly, since
   * a bare key carries no application context to describe.
   */
  target?: string;
};

/** The flags that name a source instance, for a refusal that can't ask. */
const NAME_A_SOURCE =
  "Name the source instance with one of:\n" +
  "  `--secret-key <sk_...>` — the source instance's secret key\n" +
  "  `--app <app_id> --instance <development|production>` — an application on your account\n" +
  "  `CLERK_SECRET_KEY` — the source instance's secret key, exported";

/** Whether anyone is there to answer a picker. `-y` takes no question. */
function canAsk(options: ResolveClerkSourceOptions): boolean {
  return !options.json && !isAssumeYes() && isHuman();
}

/** {@link ClerkExportSource} plus whether the user already chose it out loud. */
type ResolvedSource = ClerkExportSource & { chosen: boolean };

async function resolveSource(
  options: ResolveClerkSourceOptions,
): Promise<ResolvedSource | undefined> {
  // What separates the two tiers is not "did the CLI have to look anything up"
  // but "did the user say which instance". A flag or an exported key is a
  // sentence they typed for this run; the linked project is a choice they made
  // for some other purpose, possibly months ago, and normally names the
  // migration's destination rather than its source. Only the second is worth
  // asking about.
  //
  // `--instance` counts on its own: paired with the linked application it
  // names one instance, and pairing it with `--app` addresses any instance on
  // the account. Without this an export could not be scripted at all outside
  // agent mode — every run would stop at a picker no flag could answer.
  const named =
    Boolean(options.secretKey) ||
    Boolean(options.app) ||
    Boolean(options.instance) ||
    Boolean(process.env.CLERK_SECRET_KEY);

  try {
    return {
      target: await describeBapiTarget(options),
      secretKey: await resolveBapiSecretKey(options),
      chosen: named,
    };
  } catch (error) {
    // An unlinked directory with no key: the resolver that names the target
    // runs first, and says "not linked" rather than "no key".
    const nothingToResolve =
      error instanceof CliError &&
      (error.code === ERROR_CODE.NO_SECRET_KEY || error.code === ERROR_CODE.NOT_LINKED);
    if (named || !nothingToResolve) throw error;
    if (!canAsk(options)) {
      throwUsageError(
        `\`clerk migrate export clerk\` has no source instance, and can't ask here. ${NAME_A_SOURCE}`,
      );
    }
    // Nothing resolved: the caller offers every instance, as it does when
    // something was resolved, rather than `clerk link`'s picker and its
    // "create a new application" row.
    return undefined;
  }
}

/** The account's applications, or `undefined` when listing them needs a login. */
async function listApps(): Promise<Application[] | undefined> {
  try {
    return await fetchAppsTolerantly();
  } catch (error) {
    // Only a missing or expired login is "can't list"; anything else is a
    // failure of its own, and goes through as one.
    if (isAuthError(error)) return undefined;
    throw error;
  }
}

/**
 * Offers every instance on the account, flat — one row per instance rather than
 * an application picker followed by an instance picker.
 *
 * An application is not what an export reads from; an instance is. Picking
 * "Migration Test" and then "development" is two questions with one answer, and
 * it hides the thing that actually matters — dev and prod are different user
 * pools, and exporting the wrong one is silent.
 *
 * Deliberately not `pickOrCreateApp`: its "+ Create a new application" choice
 * makes sense when you are choosing somewhere to *write*, and no sense at all
 * as an export source — a brand-new application has no users in it.
 *
 * @param linkedAppId the application the CLI resolved on the user's behalf.
 *   Its instances go **last**, marked: it is usually the migration's
 *   destination, and the first row is the one a reflexive Enter takes.
 * @returns undefined when there is nothing to offer. `fetchAppsTolerantly`
 *   returns empty on a degraded PLAPI, not just on an account with no
 *   applications.
 */
async function pickInstance(
  apps: Application[],
  linkedAppId?: string,
): Promise<ClerkExportSource | undefined> {
  const linked = (app: Application) => app.application_id === linkedAppId;
  const ordered = [...apps.filter((app) => !linked(app)), ...apps.filter(linked)];

  const choices = ordered.flatMap((app) =>
    (app.instances ?? []).map((instance) => ({
      name:
        `${app.name || app.application_id} - ${instanceLabel(instance)} (${instance.instance_id})` +
        (linked(app) ? " (linked: usually the destination)" : ""),
      value: { app: app.application_id, instance: instance.instance_id },
    })),
  );
  if (choices.length === 0) return undefined;

  const picked = await search<{ app: string; instance: string }>({
    message: "What Clerk instance do you want to export users from?",
    source: (term) =>
      term
        ? choices.filter((choice) => choice.name.toLowerCase().includes(term.toLowerCase()))
        : choices,
  });

  // Both halves are passed on, so the secret-key lookup runs against exactly
  // the instance that was chosen and nothing prompts a second time.
  const ctx = await resolveUsersInstanceContext(picked);
  return {
    secretKey: ctx.secretKey,
    target: ctx.appLabel ? `${ctx.appLabel} (${ctx.instanceLabel})` : undefined,
  };
}

/** The application the CLI resolved on the user's behalf, if it knows one. */
async function currentAppId(options: ResolveClerkSourceOptions): Promise<string | undefined> {
  if (options.app) return options.app;
  const resolved = await resolveProfile(options.cwd ?? process.cwd()).catch(() => undefined);
  return resolved?.profile.appId;
}

export async function resolveClerkSource(
  options: ResolveClerkSourceOptions,
): Promise<ClerkExportSource> {
  const resolved = await resolveSource(options);
  if (resolved?.chosen) return { secretKey: resolved.secretKey, target: resolved.target };
  const source = resolved && { secretKey: resolved.secretKey, target: resolved.target };

  // What the CLI resolved on its own (the linked project, a key in `.env`) is
  // normally the migration's destination. With nobody to ask, exporting it
  // and printing `clerk migrate import <id>` points the import straight back
  // at it, so the source has to be named.
  if (!canAsk(options)) {
    throwUsageError(
      `\`clerk migrate export clerk\` won't export ${source?.target ?? "the resolved instance"} without asking: it is usually where the users are going. ${NAME_A_SOURCE}`,
    );
  }

  const apps = await listApps();
  if (!apps) {
    // Listing applications needs a login. An accountless app's key is
    // already resolved, so it can still be offered on its own.
    if (!source) {
      throwUsageError(
        `Listing your applications needs \`clerk auth login\`, and nothing here names a source instance. ${NAME_A_SOURCE}`,
      );
    }
    const use = await confirm({
      message: `Listing your applications needs a login, so they can't be offered. Export from ${source.target ?? "the resolved instance"} instead?`,
      default: false,
    });
    if (use) return source;
    throwUserAbort();
  }

  const picked = await pickInstance(apps, await currentAppId(options));
  if (picked) return picked;

  throwUsageError(`There are no instances to pick from. ${NAME_A_SOURCE}`);
}
