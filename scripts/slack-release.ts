/**
 * Post a stable-release notification to Slack via an incoming webhook.
 *
 * Usage:
 *   bun scripts/slack-release.ts --version <version>
 *
 * Required env vars:
 *   SLACK_RELEASE_WEBHOOK_URL - Slack incoming webhook URL for release announcements
 *   GITHUB_REPOSITORY         - e.g. "clerk/cli"
 *   GITHUB_SERVER_URL         - e.g. "https://github.com"
 */

import { parseArgs } from "node:util";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    version: { type: "string" },
  },
  strict: true,
});

if (!values.version) {
  console.error("Usage: bun scripts/slack-release.ts --version <version>");
  process.exit(1);
}

const webhookUrl = process.env.SLACK_RELEASE_WEBHOOK_URL;
if (!webhookUrl) {
  throw new Error("SLACK_RELEASE_WEBHOOK_URL is required");
}

const repo = process.env.GITHUB_REPOSITORY ?? "clerk/cli";
const serverUrl = process.env.GITHUB_SERVER_URL ?? "https://github.com";
const tag = `v${values.version}`;
const releaseUrl = `${serverUrl}/${repo}/releases/tag/${tag}`;

const payload = {
  blocks: [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          `*:tada: clerk ${tag} released*`,
          `*Repo:* \`${repo}\``,
          `*Release:* <${releaseUrl}|View on GitHub>`,
        ].join("\n"),
      },
    },
  ],
};

const res = await fetch(webhookUrl, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});

if (!res.ok) {
  const body = await res.text();
  throw new Error(`Slack webhook failed (${res.status}): ${body}`);
}

console.log("Slack release notification sent.");
