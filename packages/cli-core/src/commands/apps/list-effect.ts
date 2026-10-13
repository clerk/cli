import { Context, Effect, Schema } from "effect";
import type { Application } from "../../lib/plapi.ts";
import { stripSecrets, type AppsOptions } from "./shared.ts";

export class AppsFailure extends Schema.TaggedError<AppsFailure>()("AppsFailure", {
  cause: Schema.Defect(),
}) {}
export class ConfigurationFailure extends Schema.TaggedError<ConfigurationFailure>()(
  "ConfigurationFailure",
  { cause: Schema.Defect() },
) {}
export class CredentialFailure extends Schema.TaggedError<CredentialFailure>()(
  "CredentialFailure",
  { cause: Schema.Defect() },
) {}
export class ApiFailure extends Schema.TaggedError<ApiFailure>()("ApiFailure", {
  cause: Schema.Defect(),
}) {}
export class OutputFailure extends Schema.TaggedError<OutputFailure>()("OutputFailure", {
  cause: Schema.Defect(),
}) {}
export type AppsError =
  | AppsFailure
  | ConfigurationFailure
  | CredentialFailure
  | ApiFailure
  | OutputFailure;
export function isAppsFailure(error: unknown): error is AppsError {
  return (
    error instanceof AppsFailure ||
    error instanceof ConfigurationFailure ||
    error instanceof CredentialFailure ||
    error instanceof ApiFailure ||
    error instanceof OutputFailure
  );
}
export class Applications extends Context.Service<
  Applications,
  {
    readonly list: Effect.Effect<Application[], AppsError>;
  }
>()("clerk/apps/Applications") {}
export class AppsOutput extends Context.Service<
  AppsOutput,
  {
    readonly fetch: <A, E, R>(
      effect: Effect.Effect<A, E, R>,
      options: AppsOptions,
    ) => Effect.Effect<A, E | AppsError, R>;
    readonly render: (
      apps: Application[],
      options: AppsOptions,
    ) => Effect.Effect<void, OutputFailure>;
    readonly wrap: <E, R>(
      effect: Effect.Effect<void, E, R>,
      options: AppsOptions,
    ) => Effect.Effect<void, E | AppsError, R>;
  }
>()("clerk/apps/Output") {}
export const listEffect = Effect.fn("apps.list")(function* (options: AppsOptions) {
  const api = yield* Applications;
  const output = yield* AppsOutput;
  yield* output.wrap(
    Effect.flatMap(output.fetch(api.list, options), (apps) =>
      output.render(apps.map(stripSecrets), options),
    ),
    options,
  );
});
