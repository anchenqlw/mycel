# Contributing to Mycel

Thanks for helping improve Mycel. This public repository is a runnable V1 demo and reference implementation for governed human-agent collaboration. Please keep changes focused, reviewable, and reproducible without private accounts.

## Before you start

Read [README.md](./README.md), [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md), and [AGENTS.md](./AGENTS.md). Open an issue first when a proposal changes the product model, a security boundary, stored event semantics, or a public interface.

Create a branch from the current public `main`; do not work directly on `main`:

```bash
git switch -c your-name/short-description
npm ci
npm run demo:public-reset
npm run doctor
```

## Change requirements

- Add or update at least one behavior-focused test for every behavior change. Assert observable contracts rather than exact human prose.
- Keep secrets, personal paths, real conversation history, provider identities, runtime databases, and account-derived fixtures out of the repository.
- Use fictional, deterministic data for tests, demos, and screenshots. Do not use fixtures captured from real DingTalk, Feishu, Claude, Codex, Git hosting, or other accounts.
- Preserve the local-first trust model: validate paths on the server, spawn argv with `shell: false`, and never treat a remote URL as authorization for a Git network or destructive operation.
- Update README or architecture documentation when behavior, package boundaries, persistence, recovery, permissions, or limitations change.

## Verification

Run the complete baseline from the repository root:

```bash
npm run typecheck
npm test
npm run build
git diff --check
```

For a material UI change, also start a fresh real local service and complete browser acceptance from a final user's point of view. Cover the main task, failure and recovery, repeated actions, waiting feedback, copy clarity, discoverability, unnecessary confirmation, keyboard and focus behavior, scrolling, overflow, desktop and narrow layouts, state consistency, console/network errors, and sensitive-data boundaries. Record what you exercised in the pull request.

`npm run test:claude-smoke` and `npm run test:demo-e2e` can invoke real local provider CLIs, consume model quota, and inherit provider/session reliability. Run them only when the changed boundary requires them. Never add CI secrets or fake a passing result when a provider is unavailable.

## Pull requests

Push your branch and open a pull request against the public repository. Include:

- the user-visible or architectural outcome;
- the behavior test added or changed;
- exact verification commands and results;
- browser acceptance notes for UI changes;
- known limitations or follow-up work;
- confirmation that no credentials or real-account fixtures are included.

Maintainers selectively review and import accepted public changes into the private development source of truth. There is no automatic bidirectional merge, and a public commit is not expected to share private repository ancestry. Contributors only need to work through public issues, branches, and pull requests.
