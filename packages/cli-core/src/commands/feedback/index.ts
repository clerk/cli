import type { Program } from "../../cli-program.ts";
import {
  ATTACHED_FIELD_PHRASES,
  feedback,
  FEEDBACK_EXAMPLES,
  FEEDBACK_OUTCOMES,
  FIELD_MAX_LENGTH_TEXT,
} from "./feedback.ts";

/**
 * The long form of `clerk feedback --help`: when to use the command, what it
 * sends, and the rules. The one-liner lives in `.summary()` so `clerk --help`
 * and the README's help block carry it. The attached fields come from the
 * same list the README is checked against.
 */
const DESCRIPTION =
  "Send Clerk a report about a problem with this CLI, or an improvement that would have helped.\n\n" +
  "Use it when a command exited 0 but did something other than what you expected, " +
  "when an error was confusing or wrong, or when a capability you needed is missing.\n\n" +
  "The report is one event on the CLI's telemetry channel: your goal, what you " +
  "attempted, what went wrong, how it ended, and optionally the command, the error " +
  "text, the error code and a suggestion, plus the usual telemetry envelope: " +
  `${ATTACHED_FIELD_PHRASES.join(", ")}.\n\n` +
  "Every text field is scrubbed before it leaves your machine, on a best-effort basis: " +
  "keys and tokens by their shape, private key blocks, Authorization headers, " +
  "credentials in URLs and in curl's -u, values assigned to secret-looking names on one line, email " +
  "addresses and home-directory paths. It misses values that span lines, structured " +
  "config files such as YAML and pretty-printed JSON, passwords with spaces, and " +
  "Markdown formatting around a label, so never include secrets, API keys or personal " +
  "data about end users. --dry-run prints exactly what would be sent.\n\n" +
  `A text field longer than ${FIELD_MAX_LENGTH_TEXT} is refused ` +
  "rather than cut. A telemetry opt-out " +
  "(`clerk telemetry disable`, CLERK_TELEMETRY_DISABLED or DO_NOT_TRACK) blocks the " +
  "send; file at https://github.com/clerk/cli/issues instead.";

export function registerFeedback(program: Program): void {
  program
    .command("feedback")
    .summary(
      "Report a wrong result, a confusing error, a missing capability or a needed improvement to Clerk",
    )
    .description(DESCRIPTION)
    .option("--goal <text>", "What you were trying to do (required)")
    .option("--attempted <text>", "What you ran and what you expected (required)")
    .option("--issue <text>", "What went wrong or was confusing (required)")
    .option("--outcome <outcome>", `How it ended: ${FEEDBACK_OUTCOMES.join(", ")} (required)`)
    .option(
      "--command <path>",
      'The CLI command involved, as typed after `clerk` (e.g. "users list"); a pasted command line is fine: global flags before the command are skipped, and arguments and flags after it are dropped',
    )
    .option("--error-text <text>", "The exact error you saw")
    .option(
      "--error-code <code>",
      "The code from the error output (e.g. not_linked); case does not matter, and it is sent in lowercase",
    )
    .option("--suggestion <text>", "What would have helped")
    .option(
      "--dry-run",
      "Print exactly what would be sent and whether a real run would send it now (the telemetry opt-out and the rate limit), and send no report. A real run can still fail to write the local config file. The report id is a placeholder; a real send assigns one. With telemetry on, it may create the config directory and the machine id. With telemetry off, a dry run writes no machine id, notice flag or rate-limit record. In agent mode, the sandbox check every command that reads the config runs may still create the config directory and write and delete a temporary file there. The run's usual end-of-run telemetry step still applies: on a first run it shows the disclosure notice and records that it was shown.",
    )
    .option("--yes", "Skip the confirmation prompt")
    .setExamples(FEEDBACK_EXAMPLES)
    .action(async (options, command) => feedback(options, command));
}
