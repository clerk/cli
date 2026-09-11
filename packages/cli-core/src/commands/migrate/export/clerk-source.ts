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
 * 1. `--secret-key` names an instance outright — it runs unquestioned.
 * 2. Anything the CLI resolved on the user's behalf (the linked project, a
 *    keyless app) is not taken silently: every instance on the account is
 *    offered, with the resolved application's instances first so "yes, that
 *    one" is still a single Enter.
 * 3. Nothing to resolve at all — no link, no key, no flags — offers those same
 *    instances, the trade `users list` makes, rather than failing on an
 *    unlinked directory.
 */

import { fetchAppsTolerantly } from "../../../lib/app-picker.ts";
import { describeBapiTarget, resolveBapiSecretKey } from "../../../lib/bapi-command.ts";
import { resolveProfile } from "../../../lib/config.ts";
import { CliError, ERROR_CODE, throwUserAbort } from "../../../lib/errors.ts";
import { search } from "../../../lib/listage.ts";
import type { ApplicationInstance } from "../../../lib/plapi.ts";
import { log } from "../../../lib/log.ts";
import { isHuman } from "../../../mode.ts";
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

/** {@link ClerkExportSource} plus whether the user already chose it out loud. */
type ResolvedSource = ClerkExportSource & { chosen: boolean };

async function resolveSource(options: ResolveClerkSourceOptions): Promise<ResolvedSource> {
  try {
    return {
      target: await describeBapiTarget(options),
      secretKey: await resolveBapiSecretKey(options),
      // Flags and env keys are a choice the user typed; the linked project is
      // one they made for some other purpose, possibly months ago.
      chosen: Boolean(options.secretKey),
    };
  } catch (error) {
    const hasExplicitTarget =
      Boolean(options.secretKey) ||
      Boolean(options.app) ||
      Boolean(options.instance) ||
      Boolean(process.env.CLERK_SECRET_KEY);

    if (
      !isHuman() ||
      hasExplicitTarget ||
      !(error instanceof CliError) ||
      error.code !== ERROR_CODE.NO_SECRET_KEY
    ) {
      throw error;
    }

    const ctx = await resolveUsersInstanceContext({});
    return {
      secretKey: ctx.secretKey,
      target: ctx.appLabel ? `${ctx.appLabel} (${ctx.instanceLabel})` : undefined,
      // The picker just asked. Confirming the answer to a question the user
      // answered one prompt ago is noise.
      chosen: true,
    };
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
 * @param currentAppId the application the CLI resolved on the user's behalf.
 *   Its instances lead the list, because they are the likeliest answer.
 * @returns undefined when there is nothing to offer, so the caller can fall
 *   back to telling the user which flags to pass instead of showing an empty
 *   list. `fetchAppsTolerantly` returns empty on a degraded PLAPI, not just on
 *   an account with no applications.
 */
async function pickInstance(currentAppId?: string): Promise<ClerkExportSource | undefined> {
  const apps = await fetchAppsTolerantly();

  const ordered = currentAppId
    ? [
        ...apps.filter((app) => app.application_id === currentAppId),
        ...apps.filter((app) => app.application_id !== currentAppId),
      ]
    : apps;

  const choices = ordered.flatMap((app) =>
    (app.instances ?? []).map((instance) => ({
      name: `${app.name || app.application_id} - ${instanceLabel(instance)} (${instance.instance_id})`,
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
  const { chosen, ...source } = await resolveSource(options);
  if (chosen || !source.target || !isHuman()) return source;

  const picked = await pickInstance(await currentAppId(options));
  if (picked) return picked;

  log.info(
    "Export from a different instance with one of:\n" +
      "  `--secret-key <sk_...>` — the source instance's secret key\n" +
      "  `--app <app_id> --instance <development|production>` — another application on your account\n" +
      "  `clerk link` — link this directory to a different application first",
  );
  throwUserAbort();
}
