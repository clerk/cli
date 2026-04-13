/**
 * Post a failure notification to Slack via an incoming webhook.
 *
 * Usage:
 *   bun scripts/slack.ts --workflow <name> --status <status>
 *
 * Required env vars:
 *   SLACK_WEBHOOK_URL   — Slack incoming webhook URL
 *   GITHUB_REPOSITORY   — e.g. "clerk/cli"
 *   GITHUB_SHA          — commit SHA that triggered the run
 *   GITHUB_ACTOR        — user who triggered the run
 *   GITHUB_SERVER_URL   — e.g. "https://github.com"
 *   GITHUB_RUN_ID       — workflow run ID (used to build the logs link)
 */

import { parseArgs } from "node:util";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    workflow: { type: "string" },
    status: { type: "string" },
  },
});

if (!values.workflow || !values.status) {
  throw new Error("Usage: bun scripts/slack.ts --workflow <name> --status <status>");
}

const webhookUrl = process.env.SLACK_WEBHOOK_URL;
if (!webhookUrl) {
  throw new Error("SLACK_WEBHOOK_URL is required");
}

const repo = process.env.GITHUB_REPOSITORY ?? "clerk/cli";
const sha = process.env.GITHUB_SHA ?? "unknown";
const actor = process.env.GITHUB_ACTOR ?? "unknown";
const serverUrl = process.env.GITHUB_SERVER_URL ?? "https://github.com";
const runId = process.env.GITHUB_RUN_ID ?? "0";
const logsUrl = `${serverUrl}/${repo}/actions/runs/${runId}`;

const payload = {
  blocks: [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          `*:red_circle: ${values.workflow} failed*`,
          `*Repo:* \`${repo}\``,
          `*Status:* \`${values.status}\``,
          `*Commit:* \`${sha.slice(0, 7)}\``,
          `*Triggered by:* \`${actor}\``,
          `*Run:* <${logsUrl}|View logs>`,
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

console.log("Slack notification sent.");
