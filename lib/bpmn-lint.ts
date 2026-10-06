import type { DiagramInput, NodeInput } from "./bpmn-diagram";

/**
 * Deterministic checks on a parsed process definition. The linter never blocks
 * anything: it only reports what it finds, and the UI shows the list next to the
 * canvas. "error" marks a diagram that is structurally wrong, "hint" marks a
 * quality issue that the prompt rules (section 3d) are supposed to prevent.
 */
export type LintSeverity = "error" | "hint";

export interface LintIssue {
  severity: LintSeverity;
  path: string;
  message: string;
}

const DATA_NODE_KINDS = new Set(["dataObjectReference", "dataStoreReference"]);
const GATEWAY_KINDS = new Set([
  "exclusiveGateway",
  "inclusiveGateway",
  "parallelGateway",
  "complexGateway",
  "eventBasedGateway",
]);
const CONDITIONAL_GATEWAY_KINDS = new Set([
  "exclusiveGateway",
  "inclusiveGateway",
]);

/**
 * "Check and approve", "Prüfen und freigeben", "Save & send": a label that joins
 * two actions with a conjunction normally hides a second step.
 */
const TWO_STEPS_PATTERN = /\s(?:and|und|&)\s/i;

const describe = (node: NodeInput): string =>
  node.label?.trim() ? `"${node.label.trim()}"` : `"${node.id}"`;

export function lintDiagramInput(input: DiagramInput): LintIssue[] {
  const issues: LintIssue[] = [];
  const add = (severity: LintSeverity, path: string, message: string): void => {
    issues.push({ severity, path, message });
  };

  const nodeById = new Map(input.nodes.map((node) => [node.id, node]));
  const nodeIndexById = new Map(
    input.nodes.map((node, index) => [node.id, index] as const),
  );

  const outgoingEdgeIds = new Map<string, string[]>();
  const incomingCount = new Map<string, number>();

  for (const edge of input.edges) {
    const outgoing = outgoingEdgeIds.get(edge.sourceId) ?? [];
    outgoing.push(edge.id);
    outgoingEdgeIds.set(edge.sourceId, outgoing);
    incomingCount.set(edge.targetId, (incomingCount.get(edge.targetId) ?? 0) + 1);
  }

  const flowNodes = input.nodes.filter((node) => !DATA_NODE_KINDS.has(node.type));
  const startNodes = flowNodes.filter((node) => node.type === "startEvent");

  if (startNodes.length === 0) {
    add(
      "error",
      "process",
      "No start event: nothing marks where the process begins.",
    );
  } else if (startNodes.length > 1) {
    add(
      "hint",
      "process",
      `The process has ${startNodes.length} start events; the prompt asks for exactly one.`,
    );
  }

  input.edges.forEach((edge, index) => {
    const source = nodeById.get(edge.sourceId);
    if (source?.type === "endEvent") {
      add(
        "error",
        `edges[${index}]`,
        `Edge "${edge.id}" leaves the end event ${describe(source)}; an end event closes the flow and must not lead on.`,
      );
    }
  });

  if (startNodes.length > 0) {
    const reached = new Set(startNodes.map((node) => node.id));
    const queue = [...startNodes.map((node) => node.id)];

    while (queue.length > 0) {
      const current = queue.shift() as string;

      for (const targetId of input.edges
        .filter((edge) => edge.sourceId === current)
        .map((edge) => edge.targetId)) {
        if (!reached.has(targetId)) {
          reached.add(targetId);
          queue.push(targetId);
        }
      }
    }

    for (const node of flowNodes) {
      if (!reached.has(node.id)) {
        add(
          "error",
          `nodes[${nodeIndexById.get(node.id) ?? 0}]`,
          `${describe(node)} is never reached from a start event - it would render as a floating island.`,
        );
      }
    }
  }

  const associatedNodeIds = new Set(
    input.dataAssociations.flatMap((association) => [
      association.nodeId,
      association.dataNodeId,
    ]),
  );

  input.nodes.forEach((node, index) => {
    if (DATA_NODE_KINDS.has(node.type) && !associatedNodeIds.has(node.id)) {
      add(
        "error",
        `nodes[${index}]`,
        `Data element ${describe(node)} is not associated with any step - add a data association or drop it.`,
      );
    }
  });

  for (const node of flowNodes) {
    const branchCount = (outgoingEdgeIds.get(node.id) ?? []).length;

    if (GATEWAY_KINDS.has(node.type) && branchCount < 2) {
      add(
        "hint",
        `nodes[${nodeIndexById.get(node.id) ?? 0}]`,
        `${describe(node)} has ${branchCount === 0 ? "no" : "only one"} outgoing flow; a gateway without branches can be replaced by a direct connection.`,
      );
    }
  }

  input.edges.forEach((edge, index) => {
    const source = nodeById.get(edge.sourceId);
    if (
      source &&
      CONDITIONAL_GATEWAY_KINDS.has(source.type) &&
      !edge.condition?.trim()
    ) {
      add(
        "hint",
        `edges[${index}]`,
        `Branch "${edge.id}" from gateway ${describe(source)} has no condition; every branch of a decision needs one.`,
      );
    }
  });

  input.nodes.forEach((node, index) => {
    if (!node.label?.trim()) {
      add(
        "error",
        `nodes[${index}]`,
        `Node "${node.id}" (${node.type}) has no label and would render unnamed.`,
      );
    }
  });

  const nodeIdsByLabel = new Map<string, string[]>();
  for (const node of input.nodes) {
    const label = node.label?.trim();
    if (!label) continue;
    const ids = nodeIdsByLabel.get(label) ?? [];
    ids.push(node.id);
    nodeIdsByLabel.set(label, ids);
  }
  for (const [label, ids] of nodeIdsByLabel) {
    if (ids.length > 1) {
      add(
        "hint",
        "nodes",
        `${ids.length} nodes share the label "${label}" (${ids.join(", ")}); identical labels make the diagram ambiguous.`,
      );
    }
  }

  for (const node of flowNodes) {
    const label = node.label?.trim();
    if (label && TWO_STEPS_PATTERN.test(label)) {
      add(
        "hint",
        `nodes[${nodeIndexById.get(node.id) ?? 0}]`,
        `${describe(node)} probably describes two steps; section 3d of the prompt asks for one node per action - split it.`,
      );
    }
  }

  for (const lane of input.lanes) {
    const members = input.nodes.filter((node) => node.laneId === lane.id);
    if (members.length === 0) {
      add(
        "hint",
        `lanes[${input.lanes.indexOf(lane)}]`,
        `Lane "${lane.name?.trim() || lane.id}" contains no node; it would render as an empty band.`,
      );
    }
  }

  if (input.lanes.length > 0) {
    for (const node of flowNodes) {
      if (!node.laneId) {
        add(
          "hint",
          `nodes[${nodeIndexById.get(node.id) ?? 0}]`,
          `${describe(node)} is not assigned to a lane while the process defines ${input.lanes.length}.`,
        );
      }
    }
  }

  const rank: Record<LintSeverity, number> = { error: 0, hint: 1 };
  return issues.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
