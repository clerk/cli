import { test, expect, describe } from "bun:test";
import { generate as generateBash } from "./shells/bash.ts";
import { generate as generateZsh } from "./shells/zsh.ts";
import { generate as generateFish } from "./shells/fish.ts";
import { generate as generatePowershell } from "./shells/powershell.ts";
import { completion } from "./index.ts";
import { CliError } from "../../lib/errors.ts";

const BINARY = "clerk";

const SHELLS = [
  { name: "bash", generate: generateBash },
  { name: "zsh", generate: generateZsh },
  { name: "fish", generate: generateFish },
  { name: "powershell", generate: generatePowershell },
];

describe("completion()", () => {
  test("throws a helpful error when shell is not provided", () => {
    expect(() => completion()).toThrow(CliError);
    expect(() => completion()).toThrow(/Missing required shell argument/);
  });

  test("throws a helpful error for unsupported shells", () => {
    expect(() => completion("nushell")).toThrow(CliError);
    expect(() => completion("nushell")).toThrow(/Unsupported shell: nushell/);
  });
});

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

  test("zsh banner instructs users to mkdir ~/.zfunc before writing", () => {
    const script = generateZsh(BINARY);
    const mkdirIdx = script.indexOf("mkdir -p ~/.zfunc");
    const writeIdx = script.indexOf(`${BINARY} completion zsh > ~/.zfunc/_${BINARY}`);
    expect(mkdirIdx).toBeGreaterThan(-1);
    expect(writeIdx).toBeGreaterThan(-1);
    expect(mkdirIdx).toBeLessThan(writeIdx);
  });

  test("fish uses complete command", () => {
    expect(generateFish(BINARY)).toContain(`complete -c ${BINARY}`);
  });

  test("fish banner instructs users to mkdir ~/.config/fish/completions before writing", () => {
    const script = generateFish(BINARY);
    const mkdirIdx = script.indexOf("mkdir -p ~/.config/fish/completions");
    const writeIdx = script.indexOf(
      `${BINARY} completion fish > ~/.config/fish/completions/${BINARY}.fish`,
    );
    expect(mkdirIdx).toBeGreaterThan(-1);
    expect(writeIdx).toBeGreaterThan(-1);
    expect(mkdirIdx).toBeLessThan(writeIdx);
  });

  test("powershell uses Register-ArgumentCompleter", () => {
    expect(generatePowershell(BINARY)).toContain("Register-ArgumentCompleter");
  });

  test("powershell emits CompletionResult objects", () => {
    expect(generatePowershell(BINARY)).toContain("CompletionResult");
  });
});
