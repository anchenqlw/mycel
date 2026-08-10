import type { GraphEdge, GraphNode } from "./schemas.js";

export class DomainInvariantError extends Error {
  readonly code = "DOMAIN_INVARIANT";
}

export function assertGraphInvariants(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): void {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  if (byId.size !== nodes.length) throw new DomainInvariantError("graph node ids must be unique");

  const edgeIds = new Set<string>();
  for (const edge of edges) {
    if (edgeIds.has(edge.id)) throw new DomainInvariantError("graph edge ids must be unique");
    edgeIds.add(edge.id);
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) throw new DomainInvariantError(`edge ${edge.id} references a missing node`);

    if (edge.type === "assignment") {
      if (from.type !== "actor" || to.type !== "work") {
        throw new DomainInvariantError("assignment edges must connect Actor -> Work");
      }
      if ((edge.role === "owner" || edge.role === "acceptor") && from.kind !== "human") {
        throw new DomainInvariantError(`only a human Actor can be ${edge.role}`);
      }
    }
    if (edge.type === "authorization" && from.type !== "actor") {
      throw new DomainInvariantError("authorization edges must originate from an Actor");
    }
    if (edge.type === "delegation" && (from.type !== "actor" || to.type !== "actor")) {
      throw new DomainInvariantError("delegation edges must connect Actor -> Actor");
    }
    if (edge.type === "contains" && (from.type !== "work" || to.type !== "work")) {
      throw new DomainInvariantError("contains edges must connect Work -> Work");
    }
    if (edge.type === "equipped_with" && (from.type !== "actor" || to.type !== "capability")) {
      throw new DomainInvariantError("equipped_with edges must connect Actor -> Capability");
    }
    if (edge.type === "configured_by" && (from.type !== "actor" || to.type !== "artifact" || to.kind !== "agent-spec")) {
      throw new DomainInvariantError("configured_by edges must connect Agent Actor -> AgentSpec Artifact");
    }
    if (edge.type === "instantiates" && (from.type !== "work" || to.type !== "artifact" || to.kind !== "flow-version")) {
      throw new DomainInvariantError("instantiates edges must connect Run Work -> FlowVersion Artifact");
    }
    if (edge.type === "produces" && (from.type !== "work" || to.type !== "artifact")) {
      throw new DomainInvariantError("produces edges must connect Work -> Artifact");
    }
    if (edge.type === "references" && to.type !== "artifact") {
      throw new DomainInvariantError("references edges must target an Artifact");
    }
  }
}
