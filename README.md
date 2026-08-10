# Mycel

<p align="center">
  <strong>A local-first living production graph for durable human-agent collaboration.</strong>
</p>

<p align="center">
  English · <a href="./README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="./LICENSE"><img alt="License: Apache 2.0" src="https://img.shields.io/badge/License-Apache%202.0-CAFF5A?style=flat-square"></a>
  <img alt="Local-first" src="https://img.shields.io/badge/Local--first-by%20design-CAFF5A?style=flat-square">
  <img alt="Node.js 22.5 or newer" src="https://img.shields.io/badge/Node.js-%E2%89%A522.5-CAFF5A?style=flat-square">
</p>

Mycel is a local workbench for building long-running production relationships among people and AI agents. Steward turns intent into coordinated work, while the Living Graph keeps actors, workers, flows, runs, evidence, permissions, and artifacts connected in one shared operational model.

Conversation gives the product a natural entry point. The typed graph and local ledger give every durable decision and outcome a visible place to live.

## See Mycel in action

<p align="center">
  <a href="./docs/assets/screenshots/graph.png">
    <img src="./docs/assets/screenshots/graph.png" alt="Mycel Living Graph connecting people, agents, flows, runs, and artifacts" width="100%">
  </a>
  <br>
  <sub><strong>Living Graph</strong> — understand the production system as a connected whole.</sub>
</p>

<table>
  <tr>
    <td width="50%" valign="top">
      <a href="./docs/assets/screenshots/steward.png">
        <img src="./docs/assets/screenshots/steward.png" alt="Steward conversation and ChangeSet approval experience" width="100%">
      </a>
      <br>
      <sub><strong>Steward</strong> — express intent, review proposed changes, and stay in control.</sub>
    </td>
    <td width="50%" valign="top">
      <a href="./docs/assets/screenshots/workers.png">
        <img src="./docs/assets/screenshots/workers.png" alt="Worker management and versioned harness configuration" width="100%">
      </a>
      <br>
      <sub><strong>Workers</strong> — bring existing agents into the system or shape purpose-built ones.</sub>
    </td>
  </tr>
</table>

<p align="center">
  <a href="./docs/assets/screenshots/flow-run.png">
    <img src="./docs/assets/screenshots/flow-run.png" alt="A repeatable human and agent flow with live run status" width="100%">
  </a>
  <br>
  <sub><strong>Flows & Runs</strong> — turn collaboration patterns into repeatable production systems.</sub>
</p>

## Product philosophy

### Collaboration should build lasting context

Valuable work extends beyond a single prompt or session. Mycel keeps responsibilities, working relationships, reusable flows, outcomes, and evidence connected over time so each new run can begin with meaningful context.

### Intent should be easy to express

Steward makes natural-language conversation the front door to the system. It helps people describe goals, clarify ambiguous requests, and shape durable changes without requiring them to manipulate the graph directly.

### Everyone should share the same operational picture

The Living Graph connects people, workers, work, flows, runs, permissions, evidence, and artifacts. Teams can see what exists, how it relates, what is active, and where attention is needed from one coherent view.

### Human responsibility should stay explicit

Mycel gives Human Actors a clear place in the production model. Ownership, approval, acceptance, and intervention remain visible parts of the work, allowing agents to operate with well-defined responsibility and authority.

### Production patterns should become reusable

A successful collaboration can be shaped into a Flow, versioned, run again, and improved through accumulated evidence. Mycel helps teams turn individual successes into durable operating capability while keeping the underlying actors and context connected.

## The Mycel experience

1. **Shape the system** — tell Steward what you want to accomplish, introduce the people and workers involved, and define how they should collaborate.
2. **Run together** — start a task or reusable Flow, follow live progress, and step in when human judgment is needed.
3. **Understand and evolve** — inspect outcomes, evidence, artifacts, and history, then refine the relationships or Flow for the next run.

## What Mycel brings together

- **Steward** coordinates intent, clarification, proposed changes, and day-to-day work through conversation.
- **Living Graph** gives the production system a connected, inspectable structure that persists across sessions.
- **Workers** bring adopted local agents and purpose-built native agents into a shared model with versioned working context.
- **Flows & Runs** make human-agent collaboration repeatable, observable, and grounded in evidence and artifacts.

## Run Mycel locally

You will need Node.js 22.5 or newer, Git, and a signed-in Claude Code CLI. Codex CLI can be added as an optional Worker.

```bash
npm ci
cp .env.example .env.local
npm run demo:public-reset
npm run doctor
npm run dev
```

Open the local web address printed in the terminal. The reset command prepares a fresh local demo workspace with fictional data so you can explore the complete experience immediately.

## Learn more

- Read the [architecture guide](./docs/ARCHITECTURE.md) for the system model, package boundaries, event flow, and recovery design.
- Read the [contribution guide](./CONTRIBUTING.md) to propose improvements through the public repository.
- Read [AGENTS.md](./AGENTS.md) when contributing with an agentic coding tool.

## License

Mycel is available under the [Apache License 2.0](./LICENSE).
