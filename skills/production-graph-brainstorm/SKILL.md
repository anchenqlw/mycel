---
name: production-graph-brainstorm
description: Clarify and design persistent human-Worker production graphs before deployment. Use when a request introduces multiple actors, recurring work, schedules, repositories, permissions, approvals, joins, Adopted Workers, Native Workers, or an underspecified organizational production relationship.
---

# Production Graph Brainstorm

Turn an ambiguous production request into a safe, understandable typed ChangeSet. Mycel's deterministic Control Plane owns IDs, validation, risk, approval, and execution.

## Choose the interaction

First decide whether the user needs:

- a direct answer for a simple or read-only question;
- a clarification for one material missing decision;
- a resource reference when existing files, Flows, Tasks, Sessions, Workers, or graph objects answer the request;
- a typed command for an already-defined object;
- a ChangeSet when deployment would create or change durable work or definitions.

Do not create a workflow, graph mutation, or approval card for a simple answer. Do not infer deployment from a request to inspect, explain, summarize, or browse.

## Brainstorm complex graphs

For complex or recurring production relationships, work one decision at a time:

1. Restate the desired outcome and what will persist across runs.
2. Identify Human Actors, Adopted Workers, Native Workers, and their responsibilities.
3. Resolve exact workspace bindings. Never invent a repository path or knowledge-base binding.
4. Resolve trigger semantics, including timezone and time when scheduled work is requested.
5. Resolve dependencies and join behavior (`all`, `any`, `quorum`, or `race`).
6. Resolve human checkpoints, permission ceilings, runtime/attempt/cost budgets, and evidence expectations.
7. For each Native Worker, resolve the Harness surface that matters: engine/model, system prompt, Skills, MCP, Tools, files/knowledge, memory, budget, concurrency, lifecycle, and delegation limits.
8. Present the smallest coherent design before asking for deployment approval.

Ask only one high-leverage question per clarification. Prefer 2–3 concrete options when they genuinely help. Preserve already confirmed decisions in the design session.

## Produce a ChangeSet

Describe Workers, Human Actors, workspaces, Tasks, Flow steps, dependencies, triggers, permissions, budgets, acceptance criteria, and immutable WorkerSpec versions. Use only supported typed operations. Do not invent resource IDs. Use SecretRef for credentials and never place plaintext secrets in the ChangeSet.

Before proposing, check:

- every actor and dependency reference resolves;
- all scheduled triggers include a timezone and execution time;
- every workspace has an explicit known binding;
- Worker steps have an engine or an existing registered Worker;
- permission requests stay within the stated ceiling;
- joins are meaningful for the number of dependencies;
- the plan has a finite runtime and attempt budget;
- acceptance criteria describe observable outcomes.

If validation cannot succeed without a user decision, clarify instead of guessing.

## Communicate for approval

Keep the chat card concise: outcome, trigger, actors, steps, permissions, and notable risk. Put full prompts, budgets, and Control Plane details in expandable details. Approval means “apply this exact reviewed ChangeSet”; it does not authorize unrelated changes. Running Sessions keep their pinned WorkerSpec, Workspace, and permission lease.
