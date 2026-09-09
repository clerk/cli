import { describe, expect, test } from "bun:test";
import { normalizeIOSPlistModule, parseIOSPlist } from "./plist.ts";

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.developer.associated-domains</key>
  <array><string>webcredentials:clerk.example.test</string></array>
</dict>
</plist>`;

describe("iOS plist adapter", () => {
  test("parses XML through the source module shape", () => {
    expect(parseIOSPlist(xml)).toEqual({
      "com.apple.developer.associated-domains": ["webcredentials:clerk.example.test"],
    });
  });

  test("normalizes direct and bundled CommonJS export shapes", () => {
    const parser = { parse: (source: string) => ({ source }) };

    expect(normalizeIOSPlistModule(parser).parse("direct")).toEqual({ source: "direct" });
    expect(normalizeIOSPlistModule({ default: parser }).parse("wrapped")).toEqual({
      source: "wrapped",
    });
    expect(normalizeIOSPlistModule({ default: { default: parser } }).parse("nested")).toEqual({
      source: "nested",
    });
  });

  test("rejects an incompatible module shape", () => {
    expect(() => normalizeIOSPlistModule({ default: {} })).toThrow(
      "@expo/plist does not expose a compatible parser",
    );
  });
});
