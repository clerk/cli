/**
 * Interactive API request builder for `clerk api` (no args, human mode).
 */

import { select, input, confirm, editor } from "@inquirer/prompts";
import { isHuman } from "../../mode.ts";
import { loadCatalog, endpointsByTag, type EndpointInfo } from "./catalog.ts";
import type { ApiOptions } from "./index.ts";

export async function apiInteractive(options: ApiOptions): Promise<void> {
  if (!isHuman()) {
    console.error(
      "Interactive mode requires a TTY.\n\n" +
        "Usage:\n" +
        "  clerk api <endpoint>        Make an API request\n" +
        "  clerk api ls [filter]       List available endpoints\n" +
        "\nExample:\n" +
        "  clerk api /users\n" +
        "  clerk api ls users",
    );
    process.exit(0);
  }

  // 1. Load catalog and group by tag
  const catalog = await loadCatalog({ platform: options.platform });
  const grouped = endpointsByTag(catalog);

  // 2. Select category
  const tag = await select({
    message: "Select a category:",
    choices: catalog.tags.map((t) => ({
      name: `${t} (${grouped.get(t)!.length})`,
      value: t,
    })),
  });

  // 3. Select endpoint
  const endpoints = grouped.get(tag)!;
  const endpoint = await select<EndpointInfo>({
    message: "Select an endpoint:",
    choices: endpoints.map((e) => ({
      name: `${e.method.padEnd(7)} ${e.path.padEnd(40)} ${e.summary}`,
      value: e,
    })),
  });

  // 4. Fill path parameters
  let resolvedPath = endpoint.path;
  for (const param of endpoint.pathParams) {
    const value = await input({
      message: param.description
        ? `${param.name} (${param.description}):`
        : `${param.name}:`,
      validate: (v: string) => v.trim().length > 0 || `${param.name} is required`,
    });
    resolvedPath = resolvedPath.replace(`{${param.name}}`, value.trim());
  }

  // 5. Request body (if applicable)
  let body: string | undefined;
  if (endpoint.hasRequestBody) {
    const wantsBody = await confirm({
      message: "Provide a request body?",
      default: endpoint.method === "POST" || endpoint.method === "PUT",
    });

    if (wantsBody) {
      const bodyText = await editor({
        message: "Enter request body (JSON):",
        default: "{}",
        postfix: ".json",
        validate: (v: string) => {
          try {
            JSON.parse(v);
            return true;
          } catch {
            return "Invalid JSON";
          }
        },
      });
      body = bodyText.trim();
    }
  }

  // 6. Preview and confirm
  console.error(`\n${endpoint.method} ${resolvedPath}`);
  if (body) {
    try {
      console.error(JSON.stringify(JSON.parse(body), null, 2));
    } catch {
      console.error(body);
    }
  }

  const proceed = await confirm({ message: "Execute this request?" });
  if (!proceed) {
    console.error("Aborted.");
    return;
  }

  // 7. Delegate to the main api handler
  const { api } = await import("./index.ts");
  await api(resolvedPath, undefined, {
    ...options,
    method: endpoint.method,
    data: body,
    yes: true, // skip double-confirmation
  });
}
