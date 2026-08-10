# ProductionPlan contract

`ProductionPlan` is a semantic deployment proposal. IDs must be stable, lowercase slugs within the plan.

Required fields:

- `title`, `summary`, and observable `acceptanceCriteria`.
- `actors`: each actor is `human`, `adopted-agent`, or `graph-agent`. A graph agent includes its CLI engine and harness prompt.
- `workspaces`: explicit `workspaceId` bindings known to Mycel. Use `repository` for the configured local target repository.
- `trigger`: `manual`, `schedule`, `graph-event`, `file-change`, or `webhook`. A schedule includes `intervalMs`, `timeOfDay`, and IANA `timezone`.
- `steps`: actor, prompt, workspace references, dependencies, condition, join, timeout, attempts, and required capabilities.
- `permissionCeiling` and finite `budget`.

Rules:

- Do not include GraphNode, GraphEdge, or WeaveOperation data.
- Do not invent workspace IDs, paths, actor IDs, or registered integrations.
- Root steps have an empty `dependsOn` list and can run in parallel.
- A human checkpoint is a `human` step, not a permission edge.
- Use `previous-succeeded` unless the step intentionally handles failure.
- Default joins to `all`; use `quorum` only with an explicit quorum no larger than the dependency count.
- Capabilities are declarative names such as `repository-read`, `repository-write`, or `network`.
