import { expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { Applications, AppsOutput, listEffect } from "./list-effect.ts";

test("listing through replacement layers strips instance secrets from agent JSON", async () => {
  let rendered: unknown;
  const layers = Layer.mergeAll(
    Layer.succeed(Applications, {
      list: Effect.succeed([
        {
          application_id: "app_one",
          name: "One",
          instances: [
            {
              instance_id: "ins_one",
              environment_type: "development",
              publishable_key: "pk_test",
              secret_key: "sk_secret",
            },
          ],
        },
      ]),
    }),
    Layer.succeed(AppsOutput, {
      fetch: (effect) => effect,
      render: (apps) =>
        Effect.sync(() => {
          rendered = apps;
        }),
      wrap: (effect) => effect,
    }),
  );
  await Effect.runPromise(listEffect({ json: true }).pipe(Effect.provide(layers)));
  expect(rendered).toEqual([
    {
      application_id: "app_one",
      name: "One",
      instances: [
        { instance_id: "ins_one", environment_type: "development", publishable_key: "pk_test" },
      ],
    },
  ]);
});

import { runAppsList } from "./effect-cli.ts";
import { AppsConfiguration } from "./list-services.ts";

test("the Effect CLI executes apps list without optional flags", async () => {
  let rendered: unknown;
  await runAppsList(
    ["apps", "list"],
    Layer.mergeAll(
      Layer.succeed(AppsConfiguration, {
        environment: Effect.succeed(undefined),
        baseUrl: Effect.succeed("https://api.clerk.com"),
      }),
      Layer.succeed(Applications, { list: Effect.succeed([]) }),
      Layer.succeed(AppsOutput, {
        fetch: (effect) => effect,
        render: (apps) =>
          Effect.sync(() => {
            rendered = apps;
          }),
        wrap: (effect) => effect,
      }),
    ),
  );
  expect(rendered).toEqual([]);
});

import { afterAll, beforeAll } from "bun:test";
import { useCaptureLog, captureUi } from "../../test/lib/stubs.ts";
import { outputLayer } from "./list-services.ts";
import { AppsFailure, ConfigurationFailure } from "./list-effect.ts";
import { PlapiError, UserAbortError } from "../../lib/errors.ts";
import { getLogLevel } from "../../lib/log.ts";
import { getMode } from "../../mode.ts";
const oldTelemetry = process.env.CLERK_TELEMETRY_DISABLED;
const oldUpdate = process.env.CLERK_NO_UPDATE_CHECK;
beforeAll(() => {
  process.env.CLERK_TELEMETRY_DISABLED = "1";
  process.env.CLERK_NO_UPDATE_CHECK = "1";
});
afterAll(() => {
  if (oldTelemetry === undefined) delete process.env.CLERK_TELEMETRY_DISABLED;
  else process.env.CLERK_TELEMETRY_DISABLED = oldTelemetry;
  if (oldUpdate === undefined) delete process.env.CLERK_NO_UPDATE_CHECK;
  else process.env.CLERK_NO_UPDATE_CHECK = oldUpdate;
});
const captured = useCaptureLog();
const fixture = [
  {
    application_id: "app_one",
    name: "One",
    instances: [
      {
        instance_id: "ins_one",
        environment_type: "development",
        publishable_key: "pk_test",
        secret_key: "sk_secret",
      },
    ],
  },
];
function layers(
  list: Effect.Effect<typeof fixture, AppsFailure>,
  environment: Effect.Effect<string | undefined, ConfigurationFailure> = Effect.succeed(undefined),
) {
  return Layer.mergeAll(
    Layer.succeed(Applications, { list }),
    Layer.succeed(AppsConfiguration, {
      environment,
      baseUrl: Effect.succeed("https://api.clerk.com"),
    }),
    outputLayer,
  );
}

test("agent command produces compatible JSON with no instance secrets", async () => {
  await runAppsList(["apps", "list", "--mode", "agent"], layers(Effect.succeed(fixture)));
  expect(JSON.parse(captured.out)).toEqual([
    {
      application_id: "app_one",
      name: "One",
      instances: [
        { instance_id: "ins_one", environment_type: "development", publishable_key: "pk_test" },
      ],
    },
  ]);
});

test("human listing renders table and closes the managed gutter", async () => {
  const ui = captureUi();
  ui.install();
  try {
    await runAppsList(["--mode", "human", "apps", "list"], layers(Effect.succeed(fixture)));
    expect(ui.out).toContain("One");
    expect(ui.out).toContain("app_one");
    expect(ui.out).toContain("1 application");
    expect(ui.out).toContain("Done");
  } finally {
    ui.teardown();
  }
});

test("empty human listing prints existing create guidance", async () => {
  const ui = captureUi();
  ui.install();
  try {
    await runAppsList(["apps", "list", "--mode", "human"], layers(Effect.succeed([])));
    expect(ui.out).toContain("No applications found. Create one at https://dashboard.clerk.com");
  } finally {
    ui.teardown();
  }
});

test("API failures retain their original typed error at executable boundary", async () => {
  const error = new PlapiError(403, '{"errors":[{"message":"Denied"}]}');
  await expect(
    runAppsList(
      ["apps", "list", "--mode", "agent"],
      layers(Effect.fail(new AppsFailure({ cause: error }))),
    ),
  ).rejects.toBe(error);
});

test("prompt cancellation remains a UserAbortError and pauses human output", async () => {
  const error = new UserAbortError();
  const ui = captureUi();
  ui.install();
  try {
    await expect(
      runAppsList(
        ["apps", "list", "--mode", "human"],
        layers(Effect.fail(new AppsFailure({ cause: error }))),
      ),
    ).rejects.toBe(error);
    expect(ui.out).toContain("Paused");
    expect(ui.out).not.toContain("Failed");
  } finally {
    ui.teardown();
  }
});

test("shared flags initialize once and explicit later mode wins", async () => {
  let reads = 0;
  await runAppsList(
    ["--mode", "human", "apps", "--mode", "agent", "list", "--verbose"],
    layers(
      Effect.succeed([]),
      Effect.sync(() => {
        reads++;
        return undefined;
      }),
    ),
  );
  expect(reads).toBe(1);
  expect(getMode()).toBe("agent");
  expect(getLogLevel()).toBe("debug");
  await runAppsList(["apps", "list", "--mode", "agent"], layers(Effect.succeed([])));
  expect(getLogLevel()).toBe("info");
});

import { AppsCredentials, applicationsLayer } from "./list-services.ts";
test("configuration and credentials are replaced at command execution while API layer performs the request", async () => {
  const authorization: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      authorization.push(request.headers.get("authorization") ?? "");
      return Response.json(fixture);
    },
  });
  let tokenReads = 0;
  const dependencies = Layer.mergeAll(
    Layer.succeed(AppsConfiguration, {
      environment: Effect.succeed(undefined),
      baseUrl: Effect.succeed(server.url.toString()),
    }),
    Layer.succeed(AppsCredentials, {
      token: Effect.sync(() => {
        tokenReads++;
        return "replacement-token";
      }),
    }),
  );
  try {
    await runAppsList(
      ["apps", "list", "--mode", "agent"],
      Layer.mergeAll(
        dependencies,
        outputLayer,
        applicationsLayer.pipe(Layer.provide(dependencies)),
      ),
    );
    expect(authorization).toEqual(["Bearer replacement-token"]);
    expect(tokenReads).toBe(1);
    expect(JSON.parse(captured.out)[0].application_id).toBe("app_one");
    expect(captured.out).not.toContain("sk_secret");
  } finally {
    await server.stop(true);
  }
});

test("a leading operand delimiter keeps later flags literal before command execution", async () => {
  let requests = 0;
  await expect(
    runAppsList(
      ["--", "apps", "list", "--json"],
      layers(
        Effect.sync(() => {
          requests++;
          return [];
        }),
      ),
    ),
  ).rejects.toThrow("too many arguments for 'list'");
  expect(requests).toBe(0);
});
