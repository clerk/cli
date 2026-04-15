const repo = "clerk/cli";
const [owner, repoName] = repo.split("/");

// Authors excluded from changelog attribution. Used to suppress AI assistants
// or automation accounts that should not be credited as contributors.
const EXCLUDED_EMAILS = new Set(["noreply@anthropic.com"]);
// Logins are matched case-insensitively (compare against lowercase).
const EXCLUDED_LOGINS = new Set(["claude", "claude[bot]", "claude-code[bot]"]);

function isExcludedLogin(login) {
  return typeof login === "string" && EXCLUDED_LOGINS.has(login.toLowerCase());
}

function isExcludedUser(user) {
  return Boolean(user && isExcludedLogin(user.login));
}

// Cache to avoid duplicate fetches for the same commit/PR. Stores in-flight
// promises so concurrent callers for the same key share a single request.
const cache = new Map();

function getOrSetCached(key, loader) {
  if (cache.has(key)) return cache.get(key);
  const pending = (async () => {
    try {
      return await loader();
    } catch (err) {
      cache.delete(key);
      throw err;
    }
  })();
  cache.set(key, pending);
  return pending;
}

const GITHUB_TIMEOUT_MS = 15000;
const GITHUB_RETRY_BACKOFF_MS = 1000;
const GITHUB_MAX_RETRIES = 1;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Set once when GitHub enrichment can't proceed (missing token, etc.) so
// subsequent loaders skip the network and return plain entries silently.
let enrichmentDisabled = false;
function disableEnrichment(reason) {
  if (enrichmentDisabled) return;
  enrichmentDisabled = true;
  // eslint-disable-next-line no-console -- intentional one-shot warning when GitHub enrichment is unavailable.
  console.warn(
    `changelog: GitHub enrichment disabled (${reason}). Generated entries will lack PR and commit links.`,
  );
}

// Simple concurrency limiter to avoid hitting GitHub secondary rate limits
const MAX_CONCURRENT = 6;
let active = 0;
const queue = [];

function withLimit(fn) {
  return (...args) =>
    new Promise((resolve, reject) => {
      const run = async () => {
        active++;
        try {
          resolve(await fn(...args));
        } catch (e) {
          reject(e);
        } finally {
          active--;
          if (queue.length > 0) queue.shift()();
        }
      };
      if (active < MAX_CONCURRENT) run();
      else queue.push(run);
    });
}

async function graphql(query) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN environment variable is required");
  }

  let lastError;
  for (let attempt = 0; attempt <= GITHUB_MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GITHUB_TIMEOUT_MS);
    let res;
    try {
      res = await fetch("https://api.github.com/graphql", {
        method: "POST",
        headers: {
          Authorization: `Token ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query }),
        signal: controller.signal,
      });
    } catch (err) {
      lastError = err;
      if (
        attempt < GITHUB_MAX_RETRIES &&
        (err.name === "AbortError" || err.code === "ECONNRESET")
      ) {
        await sleep(GITHUB_RETRY_BACKOFF_MS);
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }

    if (res.status >= 500 && res.status < 600 && attempt < GITHUB_MAX_RETRIES) {
      lastError = new Error(`GitHub API responded with ${res.status}`);
      await sleep(GITHUB_RETRY_BACKOFF_MS);
      continue;
    }

    if (!res.ok) {
      throw new Error(`GitHub API responded with ${res.status}: ${await res.text()}`);
    }

    const json = await res.json();
    if (json.errors) {
      throw new Error(`GitHub GraphQL error: ${JSON.stringify(json.errors, null, 2)}`);
    }
    if (!json.data) {
      throw new Error(`Unexpected GitHub response: ${JSON.stringify(json)}`);
    }
    return json.data;
  }

  throw lastError;
}

// Returns null instead of throwing when enrichment is unavailable (no token,
// network blip after retry, etc.), so loaders fall back to plain entries.
async function tryGraphql(query) {
  if (enrichmentDisabled) return null;
  try {
    return await graphql(query);
  } catch (err) {
    disableEnrichment(err.message);
    return null;
  }
}

const emptyCommitInfo = (commit) => ({
  user: null,
  pull: null,
  links: {
    commit: `[\`${commit.slice(0, 7)}\`](https://github.com/${repo}/commit/${commit})`,
    pull: null,
    user: null,
  },
});

const emptyPullInfo = (pull) => ({
  user: null,
  commit: null,
  links: {
    commit: null,
    pull: `[#${pull}](https://github.com/${repo}/pull/${pull})`,
    user: null,
  },
});

// Fetches commit info with a single small GraphQL query per commit
const fetchCommitInfo = withLimit((commit) =>
  getOrSetCached(`commit:${commit}`, async () => {
    const data = await tryGraphql(`query {
      repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repoName)}) {
        object(expression: ${JSON.stringify(commit)}) {
          ... on Commit {
            commitUrl
            associatedPullRequests(first: 50) {
              nodes { number url mergedAt author { login url } }
            }
            author { email user { login url } }
          }
        }
      }
    }`);

    if (!data) return emptyCommitInfo(commit);

    const obj = data.repository.object;
    if (!obj) return emptyCommitInfo(commit);

    const commitAuthorExcluded =
      obj.author && (EXCLUDED_EMAILS.has(obj.author.email) || isExcludedUser(obj.author.user));
    let user = commitAuthorExcluded ? null : obj.author && obj.author.user ? obj.author.user : null;

    const associatedPR =
      obj.associatedPullRequests &&
      obj.associatedPullRequests.nodes &&
      obj.associatedPullRequests.nodes.length
        ? obj.associatedPullRequests.nodes.sort((a, b) => {
            if (a.mergedAt === null && b.mergedAt === null) return 0;
            if (a.mergedAt === null) return 1;
            if (b.mergedAt === null) return -1;
            return new Date(b.mergedAt) - new Date(a.mergedAt);
          })[0]
        : null;

    if (associatedPR && associatedPR.author && !isExcludedUser(associatedPR.author)) {
      user = associatedPR.author;
    }

    return {
      user: user ? user.login : null,
      pull: associatedPR ? associatedPR.number : null,
      links: {
        commit: `[\`${commit.slice(0, 7)}\`](${obj.commitUrl})`,
        pull: associatedPR ? `[#${associatedPR.number}](${associatedPR.url})` : null,
        user: user ? `[@${user.login}](${user.url})` : null,
      },
    };
  }),
);

// Fetches pull request info with a single small GraphQL query per PR
const fetchPullRequestInfo = withLimit((pull) =>
  getOrSetCached(`pull:${pull}`, async () => {
    const data = await tryGraphql(`query {
      repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repoName)}) {
        pullRequest(number: ${pull}) {
          url
          author { login url }
          mergeCommit { commitUrl abbreviatedOid }
        }
      }
    }`);

    if (!data) return emptyPullInfo(pull);

    const pr = data.repository.pullRequest;
    const prAuthor = pr && pr.author ? pr.author : null;
    const user = isExcludedUser(prAuthor) ? null : prAuthor;
    const mergeCommit = pr && pr.mergeCommit ? pr.mergeCommit : null;

    return {
      user: user ? user.login : null,
      commit: mergeCommit ? mergeCommit.abbreviatedOid : null,
      links: {
        commit: mergeCommit
          ? `[\`${mergeCommit.abbreviatedOid}\`](${mergeCommit.commitUrl})`
          : null,
        pull: `[#${pull}](https://github.com/${repo}/pull/${pull})`,
        user: user ? `[@${user.login}](${user.url})` : null,
      },
    };
  }),
);

// Drop-in replacements for @changesets/get-github-info
async function getInfo({ commit }) {
  return fetchCommitInfo(commit);
}

async function getInfoFromPullRequest({ pull }) {
  return fetchPullRequestInfo(pull);
}

const getDependencyReleaseLine = async (changesets, dependenciesUpdated) => {
  if (dependenciesUpdated.length === 0) return "";

  const commitLinks = (
    await Promise.all(
      changesets.map(async (cs) => {
        if (cs.commit) {
          const { links } = await getInfo({ commit: cs.commit });
          return links.commit;
        }
      }),
    )
  ).filter((_) => _);

  const changesetLink = commitLinks.length
    ? `- Updated dependencies [${commitLinks.join(", ")}]:`
    : `- Updated dependencies:`;

  const updatedDependenciesList = dependenciesUpdated.map(
    (dependency) => `  - ${dependency.name}@${dependency.newVersion}`,
  );

  return [changesetLink, ...updatedDependenciesList].join("\n");
};

const getReleaseLine = async (changeset, type, options) => {
  let prFromSummary;
  let commitFromSummary;
  let usersFromSummary = [];

  const replacedChangelog = changeset.summary
    .replace(/^\s*(?:pr|pull|pull\s+request):\s*#?(\d+)/im, (_, pr) => {
      let num = Number(pr);
      if (!isNaN(num)) prFromSummary = num;
      return "";
    })
    .replace(/^\s*commit:\s*([^\s]+)/im, (_, commit) => {
      commitFromSummary = commit;
      return "";
    })
    .replace(/^\s*(?:author|user):\s*@?([^\s]+)/gim, (_, user) => {
      if (!isExcludedLogin(user)) usersFromSummary.push(user);
      return "";
    })
    .trim();

  const [firstLine, ...futureLines] = replacedChangelog.split("\n").map((l) => l.trimEnd());

  const links = await (async () => {
    if (prFromSummary !== undefined) {
      let { links } = await getInfoFromPullRequest({
        pull: prFromSummary,
      });
      if (commitFromSummary) {
        links = {
          ...links,
          commit: `[\`${commitFromSummary}\`](https://github.com/${repo}/commit/${commitFromSummary})`,
        };
      }
      return links;
    }
    const commitToFetchFrom = commitFromSummary || changeset.commit;
    if (commitToFetchFrom) {
      let { links } = await getInfo({
        commit: commitToFetchFrom,
      });
      return links;
    }
    return {
      commit: null,
      pull: null,
      user: null,
    };
  })();

  const users = usersFromSummary.length
    ? usersFromSummary
        .map((userFromSummary) => `[@${userFromSummary}](https://github.com/${userFromSummary})`)
        .join(", ")
    : links.user;

  const prefix = [
    links.pull === null ? "" : ` (${links.pull})`,
    users === null ? "" : ` by ${users}`,
  ].join("");

  return `\n\n- ${firstLine}${prefix ? `${prefix} \n` : ""}\n${futureLines.map((l) => `  ${l}`).join("\n")}`;
};

const changelogFunctions = { getReleaseLine, getDependencyReleaseLine };
module.exports = changelogFunctions;
