# Security Policy

Mycel is a local-first V1 demo, not a production-hardened multi-tenant service. Please use disposable or non-sensitive repositories while evaluating it, review proposed operations before approval, and keep network/provider access within accounts you control.

## Report a vulnerability privately

Do not open a public issue for a vulnerability or include exploit details in a public pull request. Use the repository's GitHub **Security** tab to submit a private report through **Security Advisories**. Include the affected version or commit, impact, reproduction steps, and a minimal proof of concept with all credentials and personal data removed.

If Security Advisories are unavailable, ask a maintainer in a public issue to enable a private reporting channel without disclosing the vulnerability itself.

## Local data and credentials

- Runtime state, the SQLite ledger, evidence, worktrees, and temporary session material live under the resolved `MYCEL_DATA_DIR`. The application default is `.local/mycel`; the public quickstart explicitly sets it to `.local/public-demo/runtime`.
- `.local` and `.env.local` are local-only. They must not be copied into fixtures, screenshots, bug reports, or commits.
- Relative to that resolved data directory, verified IM credentials are stored at `secrets/connections.json` and Worker secrets at `secrets/worker-secrets.json`. In shell-path notation these are `$MYCEL_DATA_DIR/secrets/connections.json` and `$MYCEL_DATA_DIR/secrets/worker-secrets.json`; `$MYCEL_DATA_DIR` denotes the configured directory value, not a literal directory name. Mycel creates the secrets directory owner-only (`0700`) and secret files owner-only (`0600`) where the host supports POSIX modes.
- Secrets must not enter the typed Graph, SQLite event Ledger, browser API payloads, progress messages, documentation, test fixtures, or screenshots. Short-lived materialized Worker configuration belongs under the local data directory and is removed after its Session.

**Do not commit credentials.** This includes client secrets, tokens, cookies, authorization headers, private keys, webhooks, provider session material, `.env.local`, or a copied `.local` directory. Rotate a credential immediately if it is exposed.

## Filesystem and process boundaries

- Browser-supplied paths are not trusted. The server must resolve real paths and prove that a target remains within the registered Repository, directory, or worktree before reading, writing, previewing, or opening it.
- Worker execution is scoped to the Workspace captured for the Session. Approved code execution uses an isolated Git branch/worktree when that contract requires one.
- Commands must be spawned as an executable plus argv with `shell: false`. Never concatenate user input into a shell command.
- A remote URL is configuration, not authorization. Recording or changing it does not authorize clone, fetch, pull, push, merge, force push, remote overwrite, worktree deletion, or branch deletion. Those operations require their own explicit product interaction and policy check.

## Graph, session, and permission boundaries

- Simple questions remain direct answers. Durable side effects must become typed ChangeSets or Commands with validation and, when risk requires it, explicit Human Actor approval.
- A running Worker Session or Flow Run keeps the Workspace, immutable WorkerSpecVersion/Harness, and permission lease captured at start. Later edits do not silently widen an active execution.
- Permission leases are minimal and time-limited. Requests above the published Flow ceiling wait for explicit Human Actor handling rather than receiving silent escalation.
- User-visible progress must be summarized. Do not expose chain-of-thought, raw prompts, raw tool events, file contents, command parameters, or provider credentials as progress UI.

## External channels and providers

DingTalk and Feishu are optional channel adapters, not sources of truth. Their outages must not replace or rewrite the local Ledger. Claude Code, Codex, MCP, and A2A integrations cross into separately authenticated provider or protocol boundaries; availability, billing, data handling, and authorization also depend on those systems. MCP/A2A registration does not by itself authorize remote execution.

## Supported scope

Security fixes are applied to the latest public `main`. Because this V1 is not production-ready, no long-term support window or response-time SLA is promised. Maintainers will acknowledge and triage private reports as capacity allows.
