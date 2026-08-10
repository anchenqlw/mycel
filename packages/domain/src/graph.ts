import { GraphEdgeSchema, GraphNodeSchema, type GraphEdge, type GraphNode, type WeaveOperation } from "./schemas.js";
import { assertGraphInvariants } from "./invariants.js";

export interface GraphState {
  version: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export function emptyGraph(): GraphState {
  return { version: 0, nodes: [], edges: [] };
}

export function applyOperations(graph: GraphState, operations: readonly WeaveOperation[], occurredAt = new Date().toISOString()): GraphState {
  const nodes = [...graph.nodes];
  const edges = [...graph.edges];

  for (const operation of operations) {
    switch (operation.op) {
      case "add_node":
        if (nodes.some((node) => node.id === operation.node.id)) throw new Error(`node already exists: ${operation.node.id}`);
        nodes.push(GraphNodeSchema.parse(operation.node));
        break;
      case "update_node": {
        const index = nodes.findIndex((node) => node.id === operation.nodeId);
        if (index < 0) throw new Error(`node not found: ${operation.nodeId}`);
        nodes[index] = GraphNodeSchema.parse({ ...nodes[index], ...operation.patch, updatedAt: occurredAt });
        break;
      }
      case "add_edge":
        if (edges.some((edge) => edge.id === operation.edge.id)) throw new Error(`edge already exists: ${operation.edge.id}`);
        edges.push(GraphEdgeSchema.parse(operation.edge));
        break;
      case "remove_edge": {
        const index = edges.findIndex((edge) => edge.id === operation.edgeId);
        if (index < 0) throw new Error(`edge not found: ${operation.edgeId}`);
        edges.splice(index, 1);
        break;
      }
    }
  }

  assertGraphInvariants(nodes, edges);
  return { version: graph.version + 1, nodes, edges };
}
