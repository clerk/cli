import type { Help } from "@commander-js/extra-typings";

/**
 * Custom help formatter with two improvements over Commander defaults:
 *
 * 1. Commands display in three aligned columns: name | args | description
 *    (instead of concatenating name+args into one column)
 *
 * 2. Each section (Arguments, Options, Commands) computes its own column width
 *    (instead of sharing one width across all sections)
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
            helper.styleSubcommandDescription(cmdData[i].description),
            helper,
          ),
        );
        output = output.concat(helper.formatItemList("Commands:", items, helper));
      }

      return output.join("\n");
    },
  };
}
