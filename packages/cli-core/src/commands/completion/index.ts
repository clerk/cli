import { generate as generateBash } from "./shells/bash.ts";
import { generate as generateZsh } from "./shells/zsh.ts";
import { generate as generateFish } from "./shells/fish.ts";
import { generate as generatePowershell } from "./shells/powershell.ts";
import { throwUsageError } from "../../lib/errors.ts";

type CompletionGenerator = (binaryName: string) => string;

export const SUPPORTED_SHELLS = ["bash", "zsh", "fish", "powershell"] as const;

export type SupportedShell = (typeof SUPPORTED_SHELLS)[number];

const GENERATORS: Record<SupportedShell, CompletionGenerator> = {
  bash: generateBash,
  zsh: generateZsh,
  fish: generateFish,
  powershell: generatePowershell,
};

function isSupportedShell(shell: string): shell is SupportedShell {
  return (SUPPORTED_SHELLS as readonly string[]).includes(shell);
}

export function completion(shell: string): void {
  if (!isSupportedShell(shell)) {
    throwUsageError(`Unsupported shell: ${shell}. Supported: ${SUPPORTED_SHELLS.join(", ")}`);
  }
  process.stdout.write(GENERATORS[shell]("clerk"));
}
