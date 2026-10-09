import { describe, expect, test } from "bun:test";
import { CliError, ERROR_CODE } from "../../lib/errors.ts";
import { useCaptureLog } from "../../test/lib/stubs.ts";
import { mcpRun } from "./run.ts";

async function* lines(...chunks: string[]): AsyncIterable<string> {
  for (const chunk of chunks) yield chunk;
}

async function runAndCatch(input: AsyncIterable<string> | undefined): Promise<unknown> {
  try {
    await mcpRun({ input });
  } catch (error) {
    return error;
  }
  throw new Error("mcpRun did not throw");
}

describe("mcp run (removed)", () => {
  const captured = useCaptureLog();

  test("throws MCP_BRIDGE_REMOVED pointing at `clerk mcp install`", async () => {
    const error = await runAndCatch(undefined);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe(ERROR_CODE.MCP_BRIDGE_REMOVED);
    expect((error as CliError).message).toContain("clerk mcp install");
    expect(captured.out).toBe("");
  });

  test("answers the client's initialize request with a JSON-RPC error", async () => {
    const initialize = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await runAndCatch(lines(initialize.slice(0, 10), `${initialize.slice(10)}\n`, "ignored\n"));
    const reply = JSON.parse(captured.out) as {
      jsonrpc: string;
      id: number;
      error: { code: number; message: string };
    };
    expect(reply.jsonrpc).toBe("2.0");
    expect(reply.id).toBe(1);
    expect(reply.error.code).toBe(-32000);
    expect(reply.error.message).toContain("clerk mcp install");
  });

  test.each([
    ["a notification (no id)", `${JSON.stringify({ jsonrpc: "2.0", method: "x" })}\n`],
    ["non-JSON input", "hello\n"],
    ["empty input", ""],
  ])("writes nothing to stdout for %s", async (_label, input) => {
    const error = await runAndCatch(lines(input));
    expect((error as CliError).code).toBe(ERROR_CODE.MCP_BRIDGE_REMOVED);
    expect(captured.out).toBe("");
  });
});
