import { createArgument, type Command } from "@commander-js/extra-typings";
import { generate as generateBash } from "./shells/bash.ts";
import { generate as generateZsh } from "./shells/zsh.ts";
import { generate as generateFish } from "./shells/fish.ts";
import { generate as generatePowershell } from "./shells/powershell.ts";
import { throwUsageError } from "../../lib/errors.ts";
import { printNextSteps } from "../../lib/next-steps.ts";

type CompletionGenerator = (binaryName: string) => string;

export const SUPPORTED_SHELLS = ["bash", "zsh", "fish", "powershell"] as const;

export type SupportedShell = (typeof SUPPORTED_SHELLS)[number];

const GENERATORS: Record<SupportedShell, CompletionGenerator> = {
  bash: generateBash,
  zsh: generateZsh,
  fish: generateFish,
  powershell: generatePowershell,
};

const INSTALL_HINTS: Record<SupportedShell, readonly string[]> = {
  bash: [
    'Run `eval "$(clerk completion bash)"` to enable completions in this session',
    "Append the same line to ~/.bashrc to make it permanent",
  ],
  zsh: [
    'Run `eval "$(clerk completion zsh)"` to enable completions in this session',
    "Append the same line to ~/.zshrc to make it permanent",
  ],
  fish: [
    "Run `clerk completion fish | source` to enable completions in this session",
    "Run `clerk completion fish > $__fish_config_dir/completions/clerk.fish` to install permanently",
  ],
  powershell: [
    "Run `clerk completion powershell | Out-String | Invoke-Expression` to enable completions in this session",
    "Append the same line to your PowerShell profile to make it permanent",
  ],
};

function isSupportedShell(shell: string): shell is SupportedShell {
  return (SUPPORTED_SHELLS as readonly string[]).includes(shell);
}

export function completion(shell?: string): void {
  if (!shell) {
    throwUsageError(
      `Missing required shell argument. Supported shells: ${SUPPORTED_SHELLS.join(", ")}

Usage:
  $ clerk completion <shell>

Examples:
  $ clerk completion bash              Output bash completion script
  $ clerk completion zsh               Output zsh completion script
  $ eval "$(clerk completion bash)"    Enable completions in current session

Run 'clerk completion --help' for full setup instructions.`,
    );
  }
  if (!isSupportedShell(shell)) {
    throwUsageError(`Unsupported shell: ${shell}. Supported: ${SUPPORTED_SHELLS.join(", ")}`);
  }
  process.stdout.write(GENERATORS[shell]("clerk"));
  printNextSteps(INSTALL_HINTS[shell]);
}

export function registerCompletion(program: Command): void {
  program
    .command("completion")
    .description("Generate shell autocompletion script")
    .addArgument(
      createArgument("[shell]", `Shell type (${SUPPORTED_SHELLS.join(", ")})`).choices(
        SUPPORTED_SHELLS,
      ),
    )
    .setExamples([
      { command: "clerk completion bash", description: "Output bash completion script" },
      { command: "clerk completion zsh", description: "Output zsh completion script" },
      { command: "clerk completion fish", description: "Output fish completion script" },
      {
        command: "clerk completion powershell",
        description: "Output PowerShell completion script",
      },
    ])
    .addHelpText(
      "after",
      `
Tutorial — enable completions for your shell:

  Bash:
    $ eval "$(clerk completion bash)"                          # Current session only
    $ clerk completion bash > /etc/bash_completion.d/clerk     # Permanent (Linux)
    $ echo 'eval "$(clerk completion bash)"' >> ~/.bashrc      # Permanent (append)

  Zsh:
    $ eval "$(clerk completion zsh)"                           # Current session only
    $ mkdir -p ~/.zfunc && clerk completion zsh > ~/.zfunc/_clerk  # Permanent
    # Then add to ~/.zshrc: fpath=(~/.zfunc $fpath); autoload -Uz compinit && compinit

  Fish:
    $ mkdir -p ~/.config/fish/completions
    $ clerk completion fish > ~/.config/fish/completions/clerk.fish  # Auto-discovered

  PowerShell:
    $ clerk completion powershell | Out-String | Invoke-Expression  # Current session
    $ clerk completion powershell >> $PROFILE                       # Permanent`,
    )
    .action(completion);
}
