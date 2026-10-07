import { expect, test } from "bun:test";
import { CliError, ERROR_CODE } from "../../lib/errors.ts";
import { asRegistryError } from "./index.ts";

// Offline, `loggedFetch` throws NETWORK_UNREACHABLE; `clerk update` keeps
// reporting the registry, as it did before that existed.
test.each([
  [
    "a refused connection",
    new CliError("Could not reach x", { code: ERROR_CODE.NETWORK_UNREACHABLE }),
  ],
  ["a timeout", new Error("The operation was aborted.")],
])("%s is registry_unreachable", (_label, error) => {
  expect((asRegistryError(error) as CliError).code).toBe(ERROR_CODE.REGISTRY_UNREACHABLE);
});

test("a registry that answered keeps its own code", () => {
  const error = new CliError("Registry returned HTTP 500.", { code: ERROR_CODE.UPDATE_FAILED });
  expect(asRegistryError(error)).toBe(error);
});
