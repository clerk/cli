import { CliError, ERROR_CODE, EXIT_CODE, type ErrorCode } from "../../../lib/errors.ts";
import type { AppleTeam } from "../ios/teams.ts";

/** The questions a new app's answers come from, for an agent to ask the user. */
export const STARTER_QUESTIONS = {
  name: { flag: "--name", question: "What would you like to name your app?" },
  bundleId: { flag: "--bundle-id", question: "What Bundle ID should your app use?" },
  teamId: { flag: "--team-id", question: "Which Apple Developer team should sign your app?" },
  androidPackage: {
    flag: "--android-package",
    question: "What applicationId (package name) should your Android app use?",
  },
} as const;

/**
 * A new app's answer that only the user can give. It fails like any usage error; with `--json`,
 * init also reports it as an `input-required` status naming the flag to rerun with.
 */
export class StarterInputRequired extends CliError {
  constructor(
    message: string,
    public field: keyof typeof STARTER_QUESTIONS,
    public extra: { suggestion?: string; choices?: AppleTeam[] } = {},
    code: ErrorCode = ERROR_CODE.USAGE_ERROR,
  ) {
    super(message, {
      code,
      exitCode: code === ERROR_CODE.USAGE_ERROR ? EXIT_CODE.USAGE : EXIT_CODE.GENERAL,
    });
  }

  describe() {
    const { choices, ...extra } = this.extra;
    return {
      field: this.field,
      ...STARTER_QUESTIONS[this.field],
      issue: this.message,
      ...extra,
      // No teams to offer means the user enters a Team ID, so an empty list isn't sent.
      ...(choices?.length && { choices }),
    };
  }
}
