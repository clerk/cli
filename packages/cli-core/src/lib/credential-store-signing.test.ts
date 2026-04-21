import { describe, expect, test } from "bun:test";
import { isReleaseSignedMacosBinary } from "./credential-store.ts";

describe("isReleaseSignedMacosBinary", () => {
  test("returns false for unversioned dev builds", () => {
    const output = `
Executable=/tmp/clerk
Identifier=clerk
TeamIdentifier=L8SD6SB282
`;

    expect(isReleaseSignedMacosBinary(undefined, output)).toBe(false);
  });

  test("returns true for Clerk-signed release binaries", () => {
    const output = `
Executable=/tmp/clerk
Identifier=clerk
Authority=Developer ID Application: Clerk, Inc (L8SD6SB282)
TeamIdentifier=L8SD6SB282
`;

    expect(isReleaseSignedMacosBinary("1.2.3", output)).toBe(true);
  });

  test("returns false for non-Clerk-signed binaries", () => {
    const output = `
Executable=/opt/homebrew/bin/bun
Identifier=bun
Authority=Developer ID Application: Oven SH (7FRXF46ZSN)
TeamIdentifier=7FRXF46ZSN
`;

    expect(isReleaseSignedMacosBinary("1.2.3", output)).toBe(false);
  });

  test("returns false when the identifier does not match Clerk", () => {
    const output = `
Executable=/tmp/not-clerk
Identifier=not-clerk
TeamIdentifier=L8SD6SB282
`;

    expect(isReleaseSignedMacosBinary("1.2.3", output)).toBe(false);
  });
});
