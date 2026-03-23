import { test, expect, describe } from "bun:test";
import { generate as generateBash } from "./shells/bash.ts";
import { generate as generateZsh } from "./shells/zsh.ts";
import { generate as generateFish } from "./shells/fish.ts";
import { generate as generatePowershell } from "./shells/powershell.ts";

const BINARY = "clerk";

const SHELLS = [
  { name: "bash", generate: generateBash },
  { name: "zsh", generate: generateZsh },
  { name: "fish", generate: generateFish },
  { name: "powershell", generate: generatePowershell },
];

describe("shell script generators", () => {
  describe.each(SHELLS)("$name", ({ generate }) => {
    const script = generate(BINARY);

    test("generates non-empty script", () => {
      expect(script.length).toBeGreaterThan(0);
    });

    test("references the binary name", () => {
      expect(script).toContain(BINARY);
    });

    test("calls __complete", () => {
      expect(script).toContain("__complete");
    });
  });

  test("bash uses complete builtin", () => {
    expect(generateBash(BINARY)).toContain(
      `complete -o default -F _${BINARY}_completions ${BINARY}`,
    );
  });

  test("zsh has compdef header", () => {
    expect(generateZsh(BINARY)).toStartWith(`#compdef ${BINARY}`);
  });

  test("zsh registers via compdef", () => {
    expect(generateZsh(BINARY)).toContain(`compdef _${BINARY} ${BINARY}`);
  });

  test("zsh uses _describe", () => {
    expect(generateZsh(BINARY)).toContain("_describe");
  });

  test("fish uses complete command", () => {
    expect(generateFish(BINARY)).toContain(`complete -c ${BINARY}`);
  });

  test("powershell uses Register-ArgumentCompleter", () => {
    expect(generatePowershell(BINARY)).toContain("Register-ArgumentCompleter");
  });

  test("powershell emits CompletionResult objects", () => {
    expect(generatePowershell(BINARY)).toContain("CompletionResult");
  });
});
