# Mycel Agent Guide

## Product invariant

Mycel is a local-first living production graph. Its core is not a one-shot workflow builder: Steward dynamically coordinates durable production relationships among Human Actors, Adopted Workers, and Native Workers. Conversation is the control surface; the typed graph, SQLite ledger, runs, evidence, permissions, and artifacts are the fact surface.

## Read before changing code

1. Read [README.md](./README.md) for the runnable product, vocabulary, commands, and current limitations.
2. Read [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for package, data-flow, trust, and recovery boundaries.
3. Read [CONTRIBUTING.md](./CONTRIBUTING.md) for the public branch, testing, browser acceptance, and pull-request workflow.
4. Read the code and public tests nearest the behavior you intend to change. Do not rely on conversation history when repository files answer the question.

If a change alters documented behavior or a trust boundary, update the public README or architecture document in the same pull request.

## Architecture map

- `apps/web`: React workbench and Steward conversation control surface.
- `apps/server`: local API, SSE, runtime composition, connection provisioning, and host integrations.
- `packages/domain`: schemas and domain types shared across boundaries.
- `packages/application`: event-sourced application service and projection orchestration.
- `packages/steward-claude`: Steward intent and Claude Code harness adapter.
- `packages/agent-runtime`: Adopted Worker and Native Worker session adapters; the package name remains for compatibility.
- `packages/executor-claude-code`: argv-based process execution and isolated Git worktree support.
- `packages/flow-engine`: repeatable Human + Worker DAG runtime.
- `packages/workspace-files`: server-validated workspace registration, file tree, preview, and artifacts.
- `packages/ledger-sqlite`: durable append-only event ledger.
- `packages/channel-dingtalk`, `packages/channel-feishu`: optional IM adapters; channels are not sources of truth.

## Safety invariants

- Keep credentials in local secret storage. Never write them to Graph, Ledger, browser payloads, tests, fixtures, docs, screenshots, or logs.
- Resolve and validate real paths server-side. Never trust a browser-provided path for normal file APIs.
- Spawn commands with argv and `shell: false`; never interpolate user input into a shell command string.
- A configured remote URL is not authorization to clone, fetch, pull, push, merge, force-update, or delete.
- Running Worker Sessions and Flow Runs keep the Workspace, WorkerSpecVersion, and permission lease captured at start.
- Do not expose chain-of-thought, raw prompts, raw tool events, file contents, or command parameters as progress UI.
- Simple questions stay answers. Only durable side effects become ChangeSets or Commands.
- High-risk permission, ownership, acceptance, or remote-overwrite changes require an explicit Human Actor interaction.
- Preserve unrelated changes in a dirty worktree and avoid destructive Git or filesystem operations.

## Development workflow

- Create a branch for each contribution.
- Use `rg`/`rg --files` for discovery and keep modules bounded.
- Add or update a behavior test with every behavior change.
- For UI work, run browser acceptance against the real local service and inspect task completion, failure/recovery, repeated actions, waiting feedback, copy clarity, discoverability, keyboard/focus behavior, scrolling, overflow, responsive layout, state consistency, console/network errors, and sensitive-data boundaries.
- Never use credentials, provider identities, personal paths, real conversations, or account-derived data in fixtures or screenshots.

Before opening a public pull request, run:

```bash
npm run typecheck
npm test
npm run build
git diff --check
```

Real-provider tests can consume model quota and depend on an authenticated local provider session. Run them only when the changed boundary requires them, and report failures honestly:

```bash
npm run test:claude-smoke
npm run test:demo-e2e
```
