import { Command, type Help } from "@commander-js/extra-typings";

interface HelpItem {
  description: string;
}

export interface Example extends HelpItem {
  command: string;
}

export interface EnvVar extends HelpItem {
  name: string;
}

const examplesMap = new WeakMap<object, Example[]>();
const envVarsMap = new WeakMap<object, EnvVar[]>();

// Augment Commander's Command type with .setExamples() and .setEnvVars()
declare module "@commander-js/extra-typings" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- generics required for declaration merging
  interface Command<Args, Opts, GlobalOpts> {
    setExamples(examples: Example[]): this;
    setEnvVars(vars: EnvVar[]): this;
  }
}

Command.prototype.setExamples = function (examples: Example[]) {
  examplesMap.set(this, examples);
  return this;
};

Command.prototype.setEnvVars = function (vars: EnvVar[]) {
  envVarsMap.set(this, vars);
  return this;
};

/**
 * Render a `Title:` section whose rows are `term` + `description` aligned
 * to the longest term. Used by the Examples and Environment sections, which
 * share the same shape but differ in how the term is derived.
 */
function appendItemSection<T extends HelpItem>(
  output: string[],
  helper: Help,
  title: string,
  items: T[] | undefined,
  term: (item: T) => string,
): string[] {
  if (!items || items.length === 0) return output;
  // Resolve terms once — the lambda may be non-trivial and avoiding the
  // Math.max(...spread) keeps the call stack bounded for large lists.
  const terms = items.map(term);
  const termWidth = terms.reduce((max, t) => Math.max(max, helper.displayWidth(t)), 0);
  const formatted = items.map((item, i) =>
    helper.formatItem(terms[i]!, termWidth, item.description, helper),
  );
  return output.concat(helper.formatItemList(title, formatted, helper));
}

/**
 * Custom help formatter with three improvements over Commander defaults:
 *
 * 1. Commands display in three aligned columns: name | args | description
 * 2. Each section (Arguments, Options, Commands) computes its own column width
 * 3. Examples and Environment are first-class sections via setExamples / setEnvVars
 */
export function clerkHelpConfig(): Partial<Help> {
  return {
    formatHelp(cmd, helper) {
      const helpWidth = helper.helpWidth ?? 80;

      // Usage
      let output: string[] = [
        `${helper.styleTitle("Usage:")} ${helper.styleUsage(helper.commandUsage(cmd))}`,
        "",
      ];

      // Description
      const desc = helper.commandDescription(cmd);
      if (desc.length > 0) {
        output = output.concat([
          helper.boxWrap(helper.styleCommandDescription(desc), helpWidth),
          "",
        ]);
      }

      // Arguments — own column width
      const visibleArgs = helper.visibleArguments(cmd);
      if (visibleArgs.length > 0) {
        const termWidth = helper.longestArgumentTermLength(cmd, helper);
        const items = visibleArgs.map((arg) =>
          helper.formatItem(
            helper.styleArgumentTerm(helper.argumentTerm(arg)),
            termWidth,
            helper.styleArgumentDescription(helper.argumentDescription(arg)),
            helper,
          ),
        );
        output = output.concat(helper.formatItemList("Arguments:", items, helper));
      }

      // Options — own column width
      const visibleOpts = helper.visibleOptions(cmd);
      if (visibleOpts.length > 0) {
        const termWidth = helper.longestOptionTermLength(cmd, helper);
        const items = visibleOpts.map((opt) =>
          helper.formatItem(
            helper.styleOptionTerm(helper.optionTerm(opt)),
            termWidth,
            helper.styleOptionDescription(helper.optionDescription(opt)),
            helper,
          ),
        );
        output = output.concat(helper.formatItemList("Options:", items, helper));
      }

      // Commands — three-column layout: name | args | description
      const visibleCmds = helper.visibleCommands(cmd);
      if (visibleCmds.length > 0) {
        let maxNameLen = 0;
        const cmdData = visibleCmds.map((sub) => {
          const name = sub.name() + (sub.aliases()[0] ? "|" + sub.aliases()[0] : "");
          const argParts: string[] = [];
          if (sub.options.length > 0) argParts.push("[options]");
          for (const arg of sub.registeredArguments) {
            const argName = arg.name() + (arg.variadic ? "..." : "");
            argParts.push(arg.required ? `<${argName}>` : `[${argName}]`);
          }
          maxNameLen = Math.max(maxNameLen, name.length);
          return {
            name,
            argsStr: argParts.join(" "),
            description: helper.subcommandDescription(sub),
          };
        });

        // Pad command names to align the args column
        const terms = cmdData.map((c) =>
          c.argsStr ? c.name.padEnd(maxNameLen + 2) + c.argsStr : c.name,
        );
        const termWidth = Math.max(...terms.map((t) => helper.displayWidth(t)));
        const items = terms.map((term, i) =>
          helper.formatItem(
            helper.styleSubcommandTerm(term),
            termWidth,
            helper.styleSubcommandDescription(cmdData[i]!.description),
            helper,
          ),
        );
        output = output.concat(helper.formatItemList("Commands:", items, helper));
      }

      output = appendItemSection(
        output,
        helper,
        "Examples:",
        examplesMap.get(cmd),
        (e) => `$ ${e.command}`,
      );
      output = appendItemSection(
        output,
        helper,
        "Environment:",
        envVarsMap.get(cmd),
        (e) => e.name,
      );

      return output.join("\n");
    },
  };
}
