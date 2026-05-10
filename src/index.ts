import * as core from "@actions/core";
import * as github from "@actions/github";

type GeneratePayload = {
  prNumber: number;
  repoName: string;
  branch: string;
  metadata?: Record<string, unknown>;
};

type GenerateResponse = {
  batchId?: string;
  sessionId?: string;
  links?: { session?: string };
};

const TERMINAL_OK_STATUSES = new Set([200, 201, 202]);

async function run(): Promise<void> {
  const apiKey = core.getInput("api-key", { required: true });
  const baseUrl = core
    .getInput("api-base-url")
    .trim()
    .replace(/\/+$/, "");

  const payload = await buildPayload();
  const url = `${baseUrl}/public-api/v1/auto-generate`;

  core.info(`Dispatching test generation → POST ${url}`);
  core.info(`Payload: ${JSON.stringify(payload)}`);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ChecksumAppCode: apiKey,
    },
    body: JSON.stringify(payload),
  });

  const bodyText = await response.text();
  if (!TERMINAL_OK_STATUSES.has(response.status)) {
    core.setFailed(
      `Generation dispatch failed (HTTP ${response.status}). Body: ${bodyText}`
    );
    return;
  }

  let parsed: GenerateResponse = {};
  try {
    parsed = JSON.parse(bodyText) as GenerateResponse;
  } catch {
    core.setFailed(
      `Generation dispatch returned HTTP ${response.status} but body was not valid JSON: ${bodyText}`
    );
    return;
  }

  if (!parsed.batchId || !parsed.sessionId) {
    core.setFailed(
      `Generation dispatch returned HTTP ${response.status} but response is missing "batchId" or "sessionId": ${bodyText}`
    );
    return;
  }

  core.setOutput("batch-id", parsed.batchId);
  core.setOutput("session-id", parsed.sessionId);
  if (parsed.links?.session) core.setOutput("session-url", parsed.links.session);

  core.info(`Dispatched. Batch: ${parsed.batchId}. Session: ${parsed.sessionId}.`);

  await core.summary
    .addHeading("Checksum AI test generation dispatched", 3)
    .addList(
      [
        `PR: \`#${payload.prNumber}\` on \`${payload.repoName}\` (branch \`${payload.branch}\`)`,
        `Batch ID: \`${parsed.batchId}\``,
        `Session ID: \`${parsed.sessionId}\``,
        parsed.links?.session ? `Session: ${parsed.links.session}` : "",
      ].filter(Boolean)
    )
    .write();
}

async function buildPayload(): Promise<GeneratePayload> {
  const prNumber = await resolvePrNumber();
  const repoName = resolveRepoName();
  const branch = resolveBranch();
  const metadata = resolveMetadata();

  if (prNumber === undefined) {
    throw new Error(
      "`pr-number` could not be auto-detected from the workflow event. Pass `pr-number:` explicitly, or run on a `pull_request` / `pull_request_target` event."
    );
  }
  if (!repoName) {
    throw new Error(
      "`repo-name` could not be auto-detected from `GITHUB_REPOSITORY`. Pass `repo-name:` explicitly (e.g. `owner/repo`)."
    );
  }
  if (!branch) {
    throw new Error(
      "`branch` could not be auto-detected. Pass `branch:` explicitly with the PR head ref."
    );
  }

  return {
    prNumber,
    repoName,
    branch,
    ...(metadata ? { metadata } : {}),
  };
}

function resolveRepoName(): string | undefined {
  const explicit = core.getInput("repo-name");
  if (explicit) return explicit;
  // GITHUB_REPOSITORY is `<owner>/<repo>` — the backend expects the full
  // form for /auto-generate (unlike /auto-heal which matches on the bare
  // repo name). Read the env var directly because `github.context.repo` is
  // a throwing getter when the env var is absent.
  return process.env.GITHUB_REPOSITORY || undefined;
}

function resolveBranch(): string | undefined {
  const explicit = core.getInput("branch");
  if (explicit) return explicit;
  // On pull_request / pull_request_target, GITHUB_HEAD_REF holds the PR's
  // source branch. On push / workflow_dispatch / schedule, GITHUB_REF_NAME
  // holds the branch that triggered the run.
  const head = process.env.GITHUB_HEAD_REF;
  if (head) return head;
  return process.env.GITHUB_REF_NAME || undefined;
}

function resolveMetadata(): Record<string, unknown> | undefined {
  const raw = core.getInput("metadata");
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("`metadata` must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`\`metadata\` is not valid JSON: ${err.message}`);
    }
    throw err;
  }
}

async function resolvePrNumber(): Promise<number | undefined> {
  const explicit = core.getInput("pr-number");
  if (explicit) {
    const parsed = Number(explicit);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(
        `\`pr-number\` must be a positive integer, got: ${explicit}`
      );
    }
    return parsed;
  }

  // pull_request / pull_request_target events carry the PR number in the
  // event payload — no API call needed.
  const fromEvent = github.context.payload?.pull_request?.number;
  if (typeof fromEvent === "number") return fromEvent;

  // push / workflow_dispatch / schedule events don't carry PR data, so look
  // up an open PR with this branch as head via the GH API. Requires
  // `pull-requests: read` permission on the workflow's GITHUB_TOKEN.
  return await lookupPrNumberByBranch();
}

async function lookupPrNumberByBranch(): Promise<number | undefined> {
  const token = core.getInput("github-token");
  if (!token) {
    core.info(
      "pr-number: no github-token provided; cannot look up PR for branch."
    );
    return undefined;
  }

  const ref = process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF || "";
  const branch = ref.replace(/^refs\/heads\//, "");
  const repository = process.env.GITHUB_REPOSITORY || "";
  const [owner, repo] = repository.split("/");

  if (!branch || !owner || !repo) {
    core.info(
      `pr-number: cannot derive branch+repo (branch=${branch}, repository=${repository}); skipping lookup.`
    );
    return undefined;
  }

  try {
    const octokit = github.getOctokit(token);
    const { data: prs } = await octokit.rest.pulls.list({
      owner,
      repo,
      head: `${owner}:${branch}`,
      state: "open",
      per_page: 2,
    });
    if (prs.length === 0) {
      core.info(`pr-number: no open PR found with head ${owner}:${branch}.`);
      return undefined;
    }
    if (prs.length > 1) {
      core.warning(
        `pr-number: multiple open PRs found with head ${owner}:${branch}; using #${prs[0]!.number}.`
      );
    }
    core.info(`pr-number: auto-resolved to #${prs[0]!.number} from open PR.`);
    return prs[0]!.number;
  } catch (err: unknown) {
    const status = (err as { status?: number })?.status;
    if (status === 401 || status === 403) {
      core.warning(
        "pr-number: GH API returned 403/401 looking up the PR. Add `permissions: pull-requests: read` to the workflow (or pass `pr-number:` explicitly)."
      );
    } else {
      const message = err instanceof Error ? err.message : String(err);
      core.warning(`pr-number: PR lookup failed: ${message}`);
    }
    return undefined;
  }
}

run().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  core.setFailed(message);
});
