import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test";
import {
  inferChannelFromVersion,
  getUpdateChannel,
  compareSemver,
  shouldCheckForUpdates,
} from "./update-check.ts";
import * as mode from "../mode.ts";

// ── inferChannelFromVersion ───────────────────────────────────────────────────

describe("inferChannelFromVersion", () => {
  test("extracts canary channel from canary version", () => {
    expect(inferChannelFromVersion("0.0.2-canary.v20260409211526")).toBe("canary");
  });

  test("returns latest for stable version with no pre-release", () => {
    expect(inferChannelFromVersion("0.8.3")).toBe("latest");
  });

  test("returns dev for dev version", () => {
    expect(inferChannelFromVersion("0.0.0-dev")).toBe("dev");
  });

  test("extracts alpha channel", () => {
    expect(inferChannelFromVersion("1.0.0-alpha.1")).toBe("alpha");
  });

  test("extracts bare pre-release label without dot metadata", () => {
    expect(inferChannelFromVersion("1.0.0-beta")).toBe("beta");
  });

  test("extracts rc channel", () => {
    expect(inferChannelFromVersion("2.0.0-rc.3")).toBe("rc");
  });

  test("returns latest for empty string", () => {
    expect(inferChannelFromVersion("")).toBe("latest");
  });
});

// ── getUpdateChannel ──────────────────────────────────────────────────────────

describe("getUpdateChannel", () => {
  let savedChannel: string | undefined;

  beforeEach(() => {
    savedChannel = process.env.CLERK_UPDATE_CHANNEL;
  });

  afterEach(() => {
    if (savedChannel === undefined) {
      delete process.env.CLERK_UPDATE_CHANNEL;
    } else {
      process.env.CLERK_UPDATE_CHANNEL = savedChannel;
    }
  });

  test("returns env var when set to canary", () => {
    process.env.CLERK_UPDATE_CHANNEL = "canary";
    expect(getUpdateChannel()).toBe("canary");
  });

  test("returns env var when set to latest", () => {
    process.env.CLERK_UPDATE_CHANNEL = "latest";
    expect(getUpdateChannel()).toBe("latest");
  });

  test("returns env var when set to arbitrary channel", () => {
    process.env.CLERK_UPDATE_CHANNEL = "beta";
    expect(getUpdateChannel()).toBe("beta");
  });

  test("falls through to version inference when env var is empty string", () => {
    process.env.CLERK_UPDATE_CHANNEL = "";
    // CLI_VERSION is undefined in tests, so getCurrentVersion() = "0.0.0-dev"
    // inferChannelFromVersion("0.0.0-dev") = "dev"
    expect(getUpdateChannel()).toBe("dev");
  });

  test("falls through to version inference when env var is unset", () => {
    delete process.env.CLERK_UPDATE_CHANNEL;
    // CLI_VERSION is undefined in tests → "0.0.0-dev" → "dev"
    expect(getUpdateChannel()).toBe("dev");
  });
});

// ── compareSemver ─────────────────────────────────────────────────────────────

describe("compareSemver", () => {
  test("stable 0.8.3 > canary 0.0.2-canary (different minor)", () => {
    expect(compareSemver("0.8.3", "0.0.2-canary.v20260409211526")).toBeGreaterThan(0);
  });

  test("canary 0.0.2-canary < stable 0.8.3", () => {
    expect(compareSemver("0.0.2-canary.v20260409211526", "0.8.3")).toBeLessThan(0);
  });

  test("newer canary timestamp > older canary timestamp", () => {
    expect(
      compareSemver("0.0.2-canary.v20260410000000", "0.0.2-canary.v20260409211526"),
    ).toBeGreaterThan(0);
  });

  test("same canary version equals itself", () => {
    expect(compareSemver("0.0.2-canary.v20260409211526", "0.0.2-canary.v20260409211526")).toBe(0);
  });

  test("canary pre-release < its own stable base version", () => {
    expect(compareSemver("0.0.2-canary.v20260409211526", "0.0.2")).toBeLessThan(0);
  });

  test("stable > pre-release at same base", () => {
    expect(compareSemver("1.0.0", "1.0.0-alpha")).toBeGreaterThan(0);
  });

  test("pre-release < stable at same base", () => {
    expect(compareSemver("1.0.0-alpha", "1.0.0")).toBeLessThan(0);
  });

  test("higher patch wins", () => {
    expect(compareSemver("1.2.4", "1.2.3")).toBeGreaterThan(0);
  });

  test("higher major wins", () => {
    expect(compareSemver("2.0.0", "1.9.9")).toBeGreaterThan(0);
  });

  test("equal versions return 0", () => {
    expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
  });
});

// ── shouldCheckForUpdates ─────────────────────────────────────────────────────

describe("shouldCheckForUpdates", () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {
      CI: process.env.CI,
      NO_UPDATE_NOTIFIER: process.env.NO_UPDATE_NOTIFIER,
      CLERK_NO_UPDATE_CHECK: process.env.CLERK_NO_UPDATE_CHECK,
    };
    delete process.env.CI;
    delete process.env.NO_UPDATE_NOTIFIER;
    delete process.env.CLERK_NO_UPDATE_CHECK;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key as string];
      else process.env[key as string] = value;
    }
  });

  test("returns false in agent mode", () => {
    // Spy on isAgent directly — module-level forcedMode from other test files
    // can override env vars, making env-based control unreliable in shared runs
    const spy = spyOn(mode, "isAgent").mockReturnValue(true);
    try {
      expect(shouldCheckForUpdates("1.0.0")).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  test("returns false for dev version", () => {
    expect(shouldCheckForUpdates("0.0.0-dev")).toBe(false);
  });

  test("returns false when CI is set", () => {
    process.env.CI = "1";
    expect(shouldCheckForUpdates("1.0.0")).toBe(false);
  });

  test("returns false when NO_UPDATE_NOTIFIER is set", () => {
    process.env.NO_UPDATE_NOTIFIER = "1";
    expect(shouldCheckForUpdates("1.0.0")).toBe(false);
  });

  test("returns false when CLERK_NO_UPDATE_CHECK is set", () => {
    process.env.CLERK_NO_UPDATE_CHECK = "1";
    expect(shouldCheckForUpdates("1.0.0")).toBe(false);
  });

  test("returns true for stable version with no guards", () => {
    const spy = spyOn(mode, "isAgent").mockReturnValue(false);
    try {
      expect(shouldCheckForUpdates("1.0.0")).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  test("returns true for canary version with no guards", () => {
    const spy = spyOn(mode, "isAgent").mockReturnValue(false);
    try {
      expect(shouldCheckForUpdates("0.0.2-canary.v20260409211526")).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
