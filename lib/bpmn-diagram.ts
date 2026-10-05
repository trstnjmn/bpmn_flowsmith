import { BpmnModdle } from "bpmn-moddle";
import type { ModdleElement } from "bpmn-moddle";
import { layoutProcess } from "bpmn-auto-layout";

export interface LaneInput {
  id: string;
  name?: string;
}

export interface NodeInput {
  id: string;
  type: string;
  label?: string;
  laneId?: string;
}

export interface EdgeInput {
  id: string;
  sourceId: string;
  targetId: string;
  condition?: string;
}

export interface DiagramInput {
  processId: string;
  processName?: string;
  lanes: LaneInput[];
  nodes: NodeInput[];
  edges: EdgeInput[];
}

export class DiagramInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiagramInputError";
  }
}

const NODE_TYPE_BY_KIND = {
  startEvent: "bpmn:StartEvent",
  endEvent: "bpmn:EndEvent",
  intermediateThrowEvent: "bpmn:IntermediateThrowEvent",
  intermediateCatchEvent: "bpmn:IntermediateCatchEvent",
  exclusiveGateway: "bpmn:ExclusiveGateway",
  inclusiveGateway: "bpmn:InclusiveGateway",
  parallelGateway: "bpmn:ParallelGateway",
  eventBasedGateway: "bpmn:EventBasedGateway",
  complexGateway: "bpmn:ComplexGateway",
  task: "bpmn:Task",
  userTask: "bpmn:UserTask",
  serviceTask: "bpmn:ServiceTask",
  manualTask: "bpmn:ManualTask",
  scriptTask: "bpmn:ScriptTask",
  sendTask: "bpmn:SendTask",
  receiveTask: "bpmn:ReceiveTask",
  businessRuleTask: "bpmn:BusinessRuleTask",
  subProcess: "bpmn:SubProcess",
  callActivity: "bpmn:CallActivity",
  dataObjectReference: "bpmn:DataObjectReference",
  dataStoreReference: "bpmn:DataStoreReference",
} as const;

export type FlowNodeKind = keyof typeof NODE_TYPE_BY_KIND;

export const SUPPORTED_NODE_TYPES: readonly string[] = Object.keys(
  NODE_TYPE_BY_KIND,
);

const TARGET_NAMESPACE = "http://bpmn.io/schema/bpmn";
const EXPORTER = "BPMN FlowSmith";
const EXPORTER_VERSION = "1.0.0";

function isFlowNodeKind(value: string): value is FlowNodeKind {
  return Object.prototype.hasOwnProperty.call(NODE_TYPE_BY_KIND, value);
}

function sliceBalancedObject(text: string, startIndex: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = startIndex; index < text.length; index += 1) {
    const character = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(startIndex, index + 1);
      }
    }
  }

  return null;
}

export function extractJsonPayload(raw: string): string {
  const text = raw.trim();

  if (!text) {
    fail(
      "The editor is empty. Paste the JSON output of the LLM, then generate again.",
    );
  }

  const candidates: string[] = [];
  const fencePattern = /```[ \t]*[a-zA-Z0-9_+-]*[ \t]*\r?\n([\s\S]*?)```/g;
  let fenceMatch = fencePattern.exec(text);

  while (fenceMatch !== null) {
    candidates.push(fenceMatch[1]);
    fenceMatch = fencePattern.exec(text);
  }

  candidates.push(text);

  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    const startIndex = trimmed.indexOf("{");

    if (startIndex === -1) {
      continue;
    }

    if (startIndex === 0) {
      try {
        JSON.parse(trimmed);
        return trimmed;
      } catch {
        // fall through to the balanced scan below
      }
    }

    const balanced = sliceBalancedObject(trimmed, startIndex);

    if (balanced === null) {
      continue;
    }

    try {
      JSON.parse(balanced);
      return balanced;
    } catch {
      // keep looking in the remaining candidates
    }
  }

  fail(
    'No JSON object found in the editor. The text must contain a BPMN definition with a "processId" and a "nodes" array.',
  );
}

function fail(message: string): never {
  throw new DiagramInputError(message);
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    fail(`${path} must be an array.`);
  }
  return value;
}

function asRequiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${path} must be a non-empty string.`);
  }
  return value.trim();
}

function asOptionalString(value: unknown, path: string): string | undefined {
  if (typeof value !== "string") {
    if (value === undefined || value === null) {
      return undefined;
    }
    fail(`${path} must be a string.`);
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function asOptionalArray(value: unknown, path: string): unknown[] {
  if (value === undefined || value === null) {
    return [];
  }
  return asArray(value, path);
}

function push(
  element: ModdleElement,
  property: string,
  value: ModdleElement,
): void {
  const collection = element.get(property) as ModdleElement[];
  collection.push(value);
}

export function parseDiagramInput(value: unknown): DiagramInput {
  const root = asRecord(value, "input");

  const processId = asRequiredString(root.processId, "processId");
  const processName = asOptionalString(root.processName, "processName");

  const lanes: LaneInput[] = [];
  const laneIds = new Set<string>();
  asOptionalArray(root.lanes, "lanes").forEach((rawLane, index) => {
    const lane = asRecord(rawLane, `lanes[${index}]`);
    const id = asRequiredString(lane.id, `lanes[${index}].id`);
    if (laneIds.has(id)) {
      fail(`Duplicate lane id "${id}" at lanes[${index}].id.`);
    }
    laneIds.add(id);
    lanes.push({
      id,
      name: asOptionalString(lane.name, `lanes[${index}].name`),
    });
  });

  const nodes: NodeInput[] = [];
  const nodeIds = new Set<string>();
  const nodeRecords = asOptionalArray(root.nodes, "nodes");
  if (nodeRecords.length === 0) {
    fail("nodes must contain at least one node.");
  }
  nodeRecords.forEach((rawNode, index) => {
    const node = asRecord(rawNode, `nodes[${index}]`);
    const id = asRequiredString(node.id, `nodes[${index}].id`);
    if (nodeIds.has(id)) {
      fail(`Duplicate node id "${id}" at nodes[${index}].id.`);
    }
    nodeIds.add(id);

    const type = asRequiredString(node.type, `nodes[${index}].type`);
    if (!isFlowNodeKind(type)) {
      fail(
        `Unsupported node type "${type}" at nodes[${index}].type. Supported types: ${SUPPORTED_NODE_TYPES.join(", ")}.`,
      );
    }

    const laneId = asOptionalString(node.laneId, `nodes[${index}].laneId`);
    if (laneId !== undefined && !laneIds.has(laneId)) {
      fail(
        `nodes[${index}].laneId references unknown lane "${laneId}". Known lanes: ${
          [...laneIds].join(", ") || "none"
        }.`,
      );
    }

    nodes.push({
      id,
      type,
      label: asOptionalString(node.label, `nodes[${index}].label`),
      laneId,
    });
  });

  const edges: EdgeInput[] = [];
  const edgeIds = new Set<string>();
  asOptionalArray(root.edges, "edges").forEach((rawEdge, index) => {
    const edge = asRecord(rawEdge, `edges[${index}]`);
    const id = asRequiredString(edge.id, `edges[${index}].id`);
    if (edgeIds.has(id)) {
      fail(`Duplicate edge id "${id}" at edges[${index}].id.`);
    }
    edgeIds.add(id);

    const sourceId = asRequiredString(edge.sourceId, `edges[${index}].sourceId`);
    const targetId = asRequiredString(edge.targetId, `edges[${index}].targetId`);
    if (!nodeIds.has(sourceId)) {
      fail(`edges[${index}].sourceId references unknown node "${sourceId}".`);
    }
    if (!nodeIds.has(targetId)) {
      fail(`edges[${index}].targetId references unknown node "${targetId}".`);
    }

    edges.push({
      id,
      sourceId,
      targetId,
      condition: asOptionalString(edge.condition, `edges[${index}].condition`),
    });
  });

  return { processId, processName, lanes, nodes, edges };
}

export async function buildBpmnXml(input: DiagramInput): Promise<string> {
  const moddle = new BpmnModdle();

  const definitions = moddle.create("bpmn:Definitions", {
    id: `Definitions_${input.processId}`,
    targetNamespace: TARGET_NAMESPACE,
    exporter: EXPORTER,
    exporterVersion: EXPORTER_VERSION,
  });

  const process = moddle.create("bpmn:Process", {
    id: input.processId,
    name: input.processName,
    isExecutable: false,
  });
  push(definitions, "rootElements", process);

  const laneMembers = new Map<string, ModdleElement[]>(
    input.lanes.map((lane) => [lane.id, []]),
  );
  const flowNodeById = new Map<string, ModdleElement>();

  for (const node of input.nodes) {
    const flowNode = moddle.create(NODE_TYPE_BY_KIND[node.type as FlowNodeKind], {
      id: node.id,
      name: node.label,
    });
    flowNodeById.set(node.id, flowNode);
    push(process, "flowElements", flowNode);

    if (node.laneId !== undefined) {
      (laneMembers.get(node.laneId) as ModdleElement[]).push(flowNode);
    }
  }

  for (const edge of input.edges) {
    const source = flowNodeById.get(edge.sourceId) as ModdleElement;
    const target = flowNodeById.get(edge.targetId) as ModdleElement;

    const sequenceFlow = moddle.create("bpmn:SequenceFlow", {
      id: edge.id,
      name: edge.condition,
      sourceRef: source,
      targetRef: target,
    });
    push(process, "flowElements", sequenceFlow);
    push(source, "outgoing", sequenceFlow);
    push(target, "incoming", sequenceFlow);
  }

  if (input.lanes.length > 0) {
    const laneSet = moddle.create("bpmn:LaneSet", {
      id: `${input.processId}_LaneSet_1`,
    });

    for (const lane of input.lanes) {
      const laneElement = moddle.create("bpmn:Lane", {
        id: lane.id,
        name: lane.name,
      });
      for (const flowNode of laneMembers.get(lane.id) ?? []) {
        push(laneElement, "flowNodeRef", flowNode);
      }
      push(laneSet, "lanes", laneElement);
    }

    push(process, "laneSets", laneSet);
  }

  const { xml } = await moddle.toXML(definitions, { format: true });
  return xml;
}

export async function layoutBpmnXml(xml: string): Promise<string> {
  return await layoutProcess(xml);
}

export async function diagramToLaidOutXml(value: unknown): Promise<string> {
  const input = parseDiagramInput(value);
  const rawXml = await buildBpmnXml(input);
  return await layoutBpmnXml(rawXml);
}