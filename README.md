# `checksum-ai/generate-action`

GitHub Action that triggers Checksum AI test generation for a pull request. The agent reads the PR diff in its sandbox, generates end-to-end tests covering the affected user flows, and opens a tests-repo PR with the new coverage.

## Quick start

```yaml
name: Checksum AI generate tests
on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: read

jobs:
  generate:
    runs-on: ubuntu-latest
    steps:
      - uses: checksum-ai/generate-action@v1
        with:
          api-key: ${{ secrets.CHECKSUM_API_KEY }}
```

That's it. PR number, repository, and branch are auto-resolved from the workflow event.

## Manual dispatch (any event)

```yaml
- uses: checksum-ai/generate-action@v1
  with:
    api-key: ${{ secrets.CHECKSUM_API_KEY }}
    pr-number: 1234
    repo-name: acme-co/web
    branch: feature/checkout-redesign
```

## Inputs

| Input | Required | Description |
|---|---|---|
| `api-key` | yes | Checksum AI API key — pass via a secret. |
| `pr-number` | no | Source PR number. Auto-resolved from the `pull_request` event payload, or from the GitHub API on `push` (requires `pull-requests: read` permission). |
| `repo-name` | no | `<owner>/<repo>`. Defaults to `GITHUB_REPOSITORY`. |
| `branch` | no | PR head branch. Defaults to `GITHUB_HEAD_REF` (on `pull_request`) or `GITHUB_REF_NAME` (on `push`). |
| `metadata` | no | JSON object attached to the generation session for tracing. |
| `api-base-url` | no | Defaults to `https://api.checksum.ai`. |
| `github-token` | no | Used to look up the open PR for the branch on `push` events. Defaults to `${{ github.token }}`. |

## Outputs

| Output | Description |
|---|---|
| `batch-id` | Generation batch UUID. Poll progress via `GET /public-api/v1/auto-generate/batch/{batchId}`. |
| `session-id` | Aiagents session UUID. |
| `session-url` | Webapp link to the agent session. |

## How it works

The action calls `POST /public-api/v1/auto-generate` with the resolved PR coordinates. The backend creates a generation batch, dispatches a CQ end-to-end-standard session, and posts a sticky progress comment on the source PR. When the agent finishes, a PR with the generated tests is opened on your tests repository.

The action exits as soon as the dispatch is accepted (~15s). Progress is reported on the source PR via the sticky comment — there's no need to keep a runner allocated while the agent works.

## Setting up secrets

In your repo settings → **Secrets and variables → Actions**, add:

- `CHECKSUM_API_KEY` — your Checksum AI API key

## Pinning

Pin to a major-version tag (`@v1`) for automatic non-breaking updates, or to a specific release (`@v1.0.0`) for a frozen reference.
