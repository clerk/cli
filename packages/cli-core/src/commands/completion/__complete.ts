import type { CommandUnknownOpts, Option } from "@commander-js/extra-typings";

const DIRECTIVE = {
  DEFAULT: 0,
  NO_FILE_COMP: 4,
} as const;

type Directive = (typeof DIRECTIVE)[keyof typeof DIRECTIVE];

interface Completion {
  name: string;
  description: string;
}

interface CompletionResult {
  completions: Completion[];
  directive: Directive;
}

const HTTP_METHOD_COMPLETIONS: Completion[] = [
  { name: "GET", description: "Read resource" },
  { name: "POST", description: "Create resource" },
  { name: "PUT", description: "Replace resource" },
  { name: "PATCH", description: "Partially update resource" },
  { name: "DELETE", description: "Delete resource" },
];

/**
 * Hardcoded option-value completions for options that don't use Commander's `.choices()`.
 * Keys are the long or short flag (e.g., "--mode", "-X").
 */
const KNOWN_OPTION_VALUES: Record<string, Completion[]> = {
  "--mode": [
    { name: "human", description: "Interactive terminal mode" },
    { name: "agent", description: "Non-interactive agent mode" },
  ],
  "--instance": [
    { name: "dev", description: "Development instance" },
    { name: "prod", description: "Production instance" },
  ],
  "--method": HTTP_METHOD_COMPLETIONS,
  "-X": HTTP_METHOD_COMPLETIONS,
};

/**
 * Entry point called from cli.ts early-exit path.
 * Outputs tab-separated completions to stdout, one per line,
 * followed by a Cobra-style directive on the final line.
 */
export function completeHandler(program: CommandUnknownOpts, args: string[]): void {
  const result = generateCompletions(program, args);
  for (const c of result.completions) {
    process.stdout.write(`${c.name}\t${c.description}\n`);
  }
  process.stdout.write(`:${result.directive}\n`);
}

/**
 * Generate completion candidates for the given argument list.
 *
 * The args array represents the words after the binary name. The last element
 * is the partial word currently being typed (may be "" if the cursor is after
 * a space). Example: for `clerk auth lo<TAB>`, args = ["auth", "lo"].
 * For `clerk auth <TAB>`, args = ["auth", ""].
 */
export function generateCompletions(root: CommandUnknownOpts, args: string[]): CompletionResult {
  const partial = args.at(-1) ?? "";
  const preceding = args.length > 0 ? args.slice(0, -1) : [];
  const { command, usedOptions, positionalCount } = walkCommandTree(root, preceding);
  const pendingValue = findPendingOptionValue(command, preceding);

  if (pendingValue) {
    return completeOptionValue(pendingValue.option, pendingValue.flag, partial);
  }

  // When partial starts with -, only show options (user is typing a flag)
  if (partial.startsWith("-")) {
    return completeOptions(command, partial, usedOptions);
  }

  // Combine subcommands + argument choices + options
  const completions = [
    ...completeSubcommands(command, partial).completions,
    ...completeArguments(command, partial, positionalCount).completions,
    ...completeOptions(command, "", usedOptions).completions,
  ];

  return { completions, directive: DIRECTIVE.NO_FILE_COMP };
}

// ── Tree walking ─────────────────────────────────────────────────────────────

function walkCommandTree(
  root: CommandUnknownOpts,
  words: string[],
): { command: CommandUnknownOpts; usedOptions: Set<string>; positionalCount: number } {
  let command = root;
  const usedOptions = new Set<string>();
  let positionalCount = 0;
  let i = 0;

  while (i < words.length) {
    const word = words[i]!;
    const sub = findSubcommand(command, word);

    if (sub) {
      command = sub;
      positionalCount = 0; // reset for the new subcommand
      i += 1;
      continue;
    }

    const opt = findOption(command, word);
    if (opt) {
      markOptionUsed(usedOptions, opt);
      i += optionTakesValue(opt) ? 2 : 1;
      continue;
    }

    // Not a subcommand or option — it's a positional argument
    positionalCount += 1;
    i += 1;
  }

  return { command, usedOptions, positionalCount };
}

function findSubcommand(cmd: CommandUnknownOpts, word: string): CommandUnknownOpts | undefined {
  return cmd.commands.find((c) => c.name() === word || c.aliases().includes(word));
}

function findOption(cmd: CommandUnknownOpts, word: string): Option | undefined {
  let current: CommandUnknownOpts | null = cmd;
  while (current) {
    const match = current.options.find((o) => o.long === word || o.short === word);
    if (match) return match;
    current = current.parent;
  }
  return undefined;
}

function findPendingOptionValue(
  cmd: CommandUnknownOpts,
  words: string[],
): { option: Option; flag: string } | null {
  const flag = words.at(-1);
  if (!flag) return null;

  const opt = findOption(cmd, flag);
  if (!opt || !optionTakesValue(opt)) return null;

  return { option: opt, flag };
}

// ── Completion generators ────────────────────────────────────────────────────

function completeSubcommands(cmd: CommandUnknownOpts, partial: string): CompletionResult {
  const completions: Completion[] = [];

  for (const sub of cmd.commands) {
    if (isHidden(sub)) continue;

    const desc = sub.description();
    pushIfMatch(completions, sub.name(), desc, partial);
    for (const alias of sub.aliases()) {
      pushIfMatch(completions, alias, desc, partial);
    }
  }

  return { completions, directive: DIRECTIVE.NO_FILE_COMP };
}

function completeArguments(
  cmd: CommandUnknownOpts,
  partial: string,
  consumedCount: number,
): CompletionResult {
  const registeredArgs = cmd.registeredArguments;
  if (consumedCount >= registeredArgs.length) {
    return { completions: [], directive: DIRECTIVE.NO_FILE_COMP };
  }

  const arg = registeredArgs[consumedCount];
  if (!arg?.argChoices) {
    return { completions: [], directive: DIRECTIVE.DEFAULT };
  }

  const completions = arg.argChoices
    .filter((c) => c.startsWith(partial))
    .map((c) => ({ name: c, description: arg.description ?? "" }));

  return { completions, directive: DIRECTIVE.NO_FILE_COMP };
}

function completeOptions(
  cmd: CommandUnknownOpts,
  partial: string,
  usedOptions: Set<string>,
): CompletionResult {
  const completions: Completion[] = [];
  const seen = new Set<string>();

  let current: CommandUnknownOpts | null = cmd;
  while (current) {
    for (const opt of current.options) {
      if (opt.hidden || isOptionUsed(opt, usedOptions)) continue;

      if (opt.long) pushIfNew(completions, seen, opt.long, opt.description, partial);
    }
    current = current.parent;
  }

  return { completions, directive: DIRECTIVE.NO_FILE_COMP };
}

function completeOptionValue(opt: Option, flag: string, partial: string): CompletionResult {
  const candidates = resolveOptionValues(opt, flag);
  if (!candidates) return { completions: [], directive: DIRECTIVE.DEFAULT };

  return {
    completions: candidates.filter((c) => c.name.startsWith(partial)),
    directive: DIRECTIVE.NO_FILE_COMP,
  };
}

function resolveOptionValues(opt: Option, flag: string): Completion[] | undefined {
  if (opt.argChoices) {
    return opt.argChoices.map((c) => ({ name: c, description: "" }));
  }
  return KNOWN_OPTION_VALUES[flag] ?? (opt.long ? KNOWN_OPTION_VALUES[opt.long] : undefined);
}

// ── Small utilities ──────────────────────────────────────────────────────────

function optionTakesValue(opt: Option): boolean {
  return opt.required || opt.optional;
}

function isHidden(cmd: CommandUnknownOpts): boolean {
  return Boolean((cmd as CommandUnknownOpts & { _hidden?: boolean })._hidden);
}

function isOptionUsed(opt: Option, used: Set<string>): boolean {
  return (
    (opt.long !== undefined && used.has(opt.long)) ||
    (opt.short !== undefined && used.has(opt.short))
  );
}

function markOptionUsed(used: Set<string>, opt: Option): void {
  if (opt.long) used.add(opt.long);
  if (opt.short) used.add(opt.short);
}

function pushIfMatch(
  completions: Completion[],
  name: string,
  description: string,
  partial: string,
): void {
  if (name.startsWith(partial)) {
    completions.push({ name, description });
  }
}

function pushIfNew(
  completions: Completion[],
  seen: Set<string>,
  name: string,
  description: string,
  partial: string,
): void {
  if (seen.has(name) || !name.startsWith(partial)) return;
  seen.add(name);
  completions.push({ name, description });
}
