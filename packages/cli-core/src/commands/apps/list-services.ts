import { Writable } from "node:stream";
import { spinner } from "@clack/prompts";
import { Context, Effect, Exit, Layer } from "effect";
import { getEnvironment } from "../../lib/config.ts";
import { getValidToken } from "../../lib/credential-store.ts";
import { getCurrentEnvName, getPlapiBaseUrl } from "../../lib/environment.ts";
import { AuthError, ERROR_CODE, CliError, PlapiError } from "../../lib/errors.ts";
import { loggedFetch } from "../../lib/fetch.ts";
import { log } from "../../lib/log.ts";
import { intro, outro, pausedOutro } from "../../lib/spinner.ts";
import { closeStatusForError, interruptedExitCode } from "../../lib/signals.ts";
import { getUiOutput, ui } from "../../lib/ui.ts";
import { isAgent } from "../../mode.ts";
import { formatAppsTable } from "./list.ts";
import { printJson } from "./shared.ts";
import type { Application } from "../../lib/plapi.ts";
import {
  Applications,
  AppsOutput,
  ConfigurationFailure,
  CredentialFailure,
  ApiFailure,
  OutputFailure,
  isAppsFailure,
} from "./list-effect.ts";

export class AppsConfiguration extends Context.Service<
  AppsConfiguration,
  {
    readonly environment: Effect.Effect<string | undefined, ConfigurationFailure>;
    readonly baseUrl: Effect.Effect<string>;
  }
>()("clerk/apps/Configuration") {}
export class AppsCredentials extends Context.Service<
  AppsCredentials,
  {
    readonly token: Effect.Effect<string, CredentialFailure>;
  }
>()("clerk/apps/Credentials") {}

const apiBoundary = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new ApiFailure({ cause }) });
export const configurationLayer = Layer.succeed(AppsConfiguration, {
  environment: Effect.tryPromise({
    try: getEnvironment,
    catch: (cause) => new ConfigurationFailure({ cause }),
  }),
  baseUrl: Effect.sync(getPlapiBaseUrl),
});
export const credentialsLayer = Layer.succeed(AppsCredentials, {
  token: Effect.gen(function* () {
    const key = process.env.CLERK_PLATFORM_API_KEY;
    if (key) {
      if (key.startsWith("sk_"))
        return yield* new CredentialFailure({
          cause: new CliError(
            "Expected a Platform API key (ak_...), but received a secret key (sk_...).\nGet the correct key from: https://dashboard.clerk.com/last-active?path=api-keys",
            { code: ERROR_CODE.INVALID_KEY_FORMAT },
          ),
        });
      yield* Effect.sync(() =>
        log.debug(
          `plapi: using CLERK_PLATFORM_API_KEY for auth (env=${getCurrentEnvName()}, target=${getPlapiBaseUrl()})`,
        ),
      );
      return key;
    }
    const token = yield* Effect.tryPromise({
      try: getValidToken,
      catch: (cause) => new CredentialFailure({ cause }),
    });
    if (!token)
      return yield* new CredentialFailure({
        cause: new AuthError({
          reason: "not_logged_in",
          message: "Not authenticated. Run `clerk auth login` or set CLERK_PLATFORM_API_KEY",
          docsUrl: "https://clerk.com/docs/guides/development/clerk-environment-variables",
        }),
      });
    yield* Effect.sync(() =>
      log.debug(
        `plapi: using OAuth token from credential store for auth (env=${getCurrentEnvName()}, target=${getPlapiBaseUrl()})`,
      ),
    );
    return token;
  }),
});
export const applicationsLayer = Layer.effect(
  Applications,
  Effect.gen(function* () {
    const config = yield* AppsConfiguration;
    const credentials = yield* AppsCredentials;
    return Applications.of({
      list: Effect.gen(function* () {
        const baseUrl = yield* config.baseUrl;
        const token = yield* credentials.token;
        const response = yield* apiBoundary(async () =>
          loggedFetch(new URL("/v1/platform/applications", baseUrl), {
            tag: "plapi",
            method: "GET",
            headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
          }),
        );
        if (!response.ok) {
          const error = yield* apiBoundary(async () => PlapiError.fromResponse(response));
          error.context = "Failed to list applications";
          return yield* new ApiFailure({ cause: error });
        }
        return yield* apiBoundary(async () => response.json() as Promise<Application[]>);
      }),
    });
  }),
);

const spinnerOutput = new Writable({
  write(chunk, _encoding, callback) {
    log.ui(String(chunk));
    callback();
  },
});
export const outputLayer = Layer.succeed(AppsOutput, {
  render: (apps, options) =>
    Effect.try({
      try: () => {
        if (printJson(apps, options)) return;
        if (apps.length === 0) {
          ui.warn("No applications found. Create one at https://dashboard.clerk.com");
          return;
        }
        formatAppsTable(apps);
        ui.message(`${apps.length} application${apps.length === 1 ? "" : "s"}`);
      },
      catch: (cause) => new OutputFailure({ cause }),
    }),
  fetch: (effect, options) => {
    if (options.json || isAgent()) return effect;
    return Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const spin = spinner({ output: getUiOutput() ?? spinnerOutput });
            spin.start("Fetching applications...");
            return spin;
          }),
          (spin, exit) =>
            Effect.sync(() => {
              if (Exit.isSuccess(exit) || interruptedExitCode() !== null)
                spin.stop("Fetching applications");
              else {
                const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail");
                const error = failure && failure._tag === "Fail" ? failure.error : undefined;
                if (closeStatusForError(isAppsFailure(error) ? error.cause : error) === "paused")
                  spin.stop("Fetching applications");
                else spin.error("Failed");
              }
            }),
        );
        return yield* effect;
      }),
    );
  },
  wrap: (effect, options) => {
    if (options.json || isAgent()) return effect;
    return Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.acquireRelease(
          Effect.sync(() => intro("Listing applications")),
          (_, exit) =>
            Effect.gen(function* () {
              const failure = Exit.isFailure(exit)
                ? exit.cause.reasons.find((reason) => reason._tag === "Fail")
                : undefined;
              const error = failure && failure._tag === "Fail" ? failure.error : undefined;
              const paused =
                interruptedExitCode() !== null ||
                closeStatusForError(isAppsFailure(error) ? error.cause : error) === "paused";
              if (paused) yield* Effect.sync(() => pausedOutro());
              else
                yield* Effect.promise(async () =>
                  outro(Exit.isSuccess(exit) ? undefined : "Failed"),
                );
            }),
        );
        yield* effect;
      }),
    );
  },
});
export const appsListLayer = Layer.mergeAll(
  configurationLayer,
  outputLayer,
  applicationsLayer.pipe(Layer.provide(Layer.mergeAll(configurationLayer, credentialsLayer))),
);
