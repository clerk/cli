import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { observeHostCapabilityFailure, _resetAgentHostStateProbe } from "./host-execution.ts";
import { setMode } from "../mode.ts";
import { useCaptureLog } from "../test/lib/stubs.ts";

describe("observeHostCapabilityFailure sandbox hinting", () => {
  const captured = useCaptureLog();

  beforeEach(() => {
    setMode("agent");
    _resetAgentHostStateProbe();
  });

  afterEach(() => {
    setMode("human");
    _resetAgentHostStateProbe();
  });

  test("a plain connectivity failure (unreachable host, VPN, DNS) does not warn", () => {
    observeHostCapabilityFailure("network", new Error("ECONNREFUSED 127.0.0.1:443"));
    expect(captured.err).not.toContain("sandboxed run");
  });

  test("a permission-like network failure warns about a possible sandbox", () => {
    observeHostCapabilityFailure("network", new Error("operation not permitted"));
    expect(captured.err).toContain("sandboxed run");
  });

  test("browser-launch and localhost-bind failures always warn", () => {
    observeHostCapabilityFailure("browser-launch", new Error("spawn ENOENT"));
    expect(captured.err).toContain("sandboxed run");
  });

  test("the hint is a single line", () => {
    observeHostCapabilityFailure("network", new Error("EPERM"));
    const warnLines = captured.err.split("\n").filter((line) => line.includes("agent mode"));
    expect(warnLines).toHaveLength(1);
  });

  test("does not warn in human mode", () => {
    setMode("human");
    observeHostCapabilityFailure("network", new Error("operation not permitted"));
    expect(captured.err).not.toContain("sandboxed run");
  });
});
