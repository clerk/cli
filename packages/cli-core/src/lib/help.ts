import { Command, type Help } from "@commander-js/extra-typings";

export interface Example {
  command: string;
  description: string;
}

const examplesMap = new WeakMap<object, Example[]>();

// Augment Commander's Command type with .setExamples()
declare module "@commander-js/extra-typings" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- generics required for declaration merging
  interface Command<Args, Opts, GlobalOpts> {
    setExamples(examples: Example[]): this;
  }
}

Command.prototype.setExamples = function (examples: Example[]) {
  examplesMap.set(this, examples);
  return this;
};

/**
 * Custom help formatter with three improvements over Commander defaults:
 *
 * 1. Commands display in three aligned columns: name | args | description
 * 2. Each section (Arguments, Options, Commands) computes its own column width
 * 3. Examples are a first-class section with auto `$ ` prefix and aligned columns
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
        const items = terms.map((term, i) => {
          const description = cmdData[i]?.description ?? "";
          return helper.formatItem(
            helper.styleSubcommandTerm(term),
            termWidth,
            helper.styleSubcommandDescription(description),
            helper,
          );
        });
        output = output.concat(helper.formatItemList("Commands:", items, helper));
      }

      // Examples — auto `$ ` prefix and aligned columns
      const examples = examplesMap.get(cmd);
      if (examples && examples.length > 0) {
        const maxTermLen = Math.max(...examples.map((e) => helper.displayWidth(`$ ${e.command}`)));
        const items = examples.map((e) =>
          helper.formatItem(`$ ${e.command}`, maxTermLen, e.description, helper),
        );
        output = output.concat(helper.formatItemList("Examples:", items, helper));
      }

      return output.join("\n");
    },
  };
}
