import { BpmnModdle } from "bpmn-moddle";
import type { Bounds, ModdleElement } from "bpmn-moddle";
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

const LANE_LABEL_WIDTH = 30;
const LANE_PADDING_X = 25;
const LANE_PADDING_Y = 28;
const LANE_ROW_GAP = 36;
const DIAGRAM_PADDING = 20;
const MIN_LANE_HEIGHT = 140;
const EDGE_CLEARANCE = 8;
const EDGE_SPACING = 14;
const CHANNEL_STEPS = 8;
const CHANNEL_MAX_STEPS = 40;
const EDGE_OVERLAP_TOLERANCE = 4;
const SELF_LOOP_OFFSET = 25;

function readBounds(element: ModdleElement): Bounds | null {
  const bounds = element.get("bounds") as Bounds | undefined;

  if (
    !bounds ||
    typeof bounds.x !== "number" ||
    typeof bounds.y !== "number" ||
    typeof bounds.width !== "number" ||
    typeof bounds.height !== "number"
  ) {
    return null;
  }

  return bounds;
}

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

/**
 * `bpmn-auto-layout` indexes elements by id and dereferences `element.di`
 * during connection routing. An id that starts with a digit makes that lookup
 * miss, which surfaces as `Cannot read properties of undefined (reading 'di')`
 * deep inside the library. Rejecting it here gives a usable message instead.
 */
const XML_ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

function assertUsableId(id: string, path: string): void {
  if (!XML_ID_PATTERN.test(id)) {
    fail(
      `Invalid id "${id}" at ${path}. Ids must start with a letter or underscore and may only contain letters, digits, "_", "-", and "." — bpmn-auto-layout cannot resolve ids that start with a digit.`,
    );
  }
}

export function parseDiagramInput(value: unknown): DiagramInput {
  const root = asRecord(value, "input");

  const processId = asRequiredString(root.processId, "processId");
  const processName = asOptionalString(root.processName, "processName");
  assertUsableId(processId, "processId");

  const lanes: LaneInput[] = [];
  const laneIds = new Set<string>();
  asOptionalArray(root.lanes, "lanes").forEach((rawLane, index) => {
    const lane = asRecord(rawLane, `lanes[${index}]`);
    const id = asRequiredString(lane.id, `lanes[${index}].id`);
    if (laneIds.has(id)) {
      fail(`Duplicate lane id "${id}" at lanes[${index}].id.`);
    }
    assertUsableId(id, `lanes[${index}].id`);
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
    assertUsableId(id, `nodes[${index}].id`);
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
    assertUsableId(id, `edges[${index}].id`);
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
  const laidOutXml = await layoutProcess(xml);
  return await applyLaneLayout(laidOutXml);
}

type BandSlot = { id: string; height: number; row: number };

type Band = {
  slots: BandSlot[];
  rowHeights: number[];
};

function planBand(memberBounds: Bounds[]): Band {
  const slots: BandSlot[] = memberBounds.map((bounds, index) => ({
    id: String(index),
    height: bounds.height,
    row: 0,
  }));

  const rowTops: number[] = [];
  const rowBottoms: number[] = [];

  const order = memberBounds
    .map((bounds, index) => ({ index, center: bounds.y + bounds.height / 2 }))
    .sort((a, b) => a.center - b.center);

  for (const { index } of order) {
    const bounds = memberBounds[index];
    let row = rowTops.findIndex((_, position) => bounds.y < rowBottoms[position] - 1);

    if (row === -1) {
      row = rowBottoms.length;
      rowTops.push(bounds.y);
      rowBottoms.push(bounds.y + bounds.height);
    } else {
      rowBottoms[row] = Math.max(rowBottoms[row], bounds.y + bounds.height);
    }

    slots[index].row = row;
  }

  const rowHeights = rowBottoms.map((bottom, row) => bottom - rowTops[row]);

  return { slots, rowHeights };
}

/**
 * bpmn-auto-layout positions flow nodes by rank only — it knows nothing about
 * lanes, so a node assigned to "Teamleiter" can end up inside the band of
 * "Sachbearbeiter", and it never emits DI for `bpmn:Lane` at all. bpmn-js
 * skips lanes without DI (see `visitIfDi` in BpmnTreeWalker), which is why
 * roles used to stay invisible.
 *
 * This keeps the horizontal rank positions from the auto-layout, re-packs the
 * vertical axis so every node sits inside the band of its own lane, routes the
 * sequence flows orthogonally again, and finally emits one `bpmn:Lane` shape
 * per lane. The 30px label band of `renderLaneLabel` is kept free by shifting
 * the whole diagram to the right.
 */
export async function applyLaneLayout(xml: string): Promise<string> {
  const moddle = new BpmnModdle();
  const { rootElement: definitions } = await moddle.fromXML(xml);

  const diagrams = definitions.get("diagrams") as ModdleElement[] | undefined;
  const plane = diagrams?.[0]?.get("plane") as ModdleElement | undefined;

  if (!plane) {
    return xml;
  }

  const planeElements = (plane.get("planeElement") as ModdleElement[]) ?? [];
  const container = plane.get("bpmnElement") as ModdleElement | undefined;
  const laneSets = (container?.get("laneSets") as ModdleElement[] | undefined) ?? [];
  const lanes = (laneSets[0]?.get("lanes") as ModdleElement[] | undefined) ?? [];

  if (lanes.length === 0) {
    return xml;
  }

  const laneIds = new Set(lanes.map((lane) => String(lane.id)));
  const isLabelShape = (element: ModdleElement): boolean =>
    element.get("isLabel") === true;

  const boundsByNodeId = new Map<string, Bounds>();

  for (const element of planeElements) {
    if (element.$type !== "bpmndi:BPMNShape" || isLabelShape(element)) {
      continue;
    }

    const businessObject = element.get("bpmnElement") as ModdleElement | undefined;

    if (businessObject === undefined || laneIds.has(String(businessObject.id))) {
      continue;
    }

    const bounds = readBounds(element);

    if (bounds && businessObject.id !== undefined) {
      boundsByNodeId.set(String(businessObject.id), bounds);
    }
  }

  if (boundsByNodeId.size === 0) {
    return xml;
  }

  const laneIndexByNodeId = new Map<string, number>();

  lanes.forEach((lane, index) => {
    const members = (lane.get("flowNodeRef") as ModdleElement[] | undefined) ?? [];

    for (const member of members) {
      laneIndexByNodeId.set(String(member.id), index);
    }
  });

  const orderedIds = (laneIndex: number): string[] =>
    [...boundsByNodeId.entries()]
      .filter(([id]) => laneIndexByNodeId.get(id) === laneIndex)
      .sort((a, b) => a[1].x - b[1].x)
      .map(([id]) => id);

  const allBounds = [...boundsByNodeId.values()];
  const minX = Math.min(...allBounds.map((bounds) => bounds.x));
  const maxX = Math.max(...allBounds.map((bounds) => bounds.x + bounds.width));

  const laneLeft = DIAGRAM_PADDING;
  const deltaX = laneLeft + LANE_LABEL_WIDTH + LANE_PADDING_X - minX;
  const laneWidth = maxX - minX + LANE_LABEL_WIDTH + LANE_PADDING_X * 2;

  const selfLoopNodeIds = new Set<string>();

  for (const element of planeElements) {
    if (element.$type !== "bpmndi:BPMNEdge") {
      continue;
    }

    const semantic = element.get("bpmnElement") as ModdleElement | undefined;
    const sourceRef = semantic?.get("sourceRef") as ModdleElement | undefined;
    const targetRef = semantic?.get("targetRef") as ModdleElement | undefined;

    if (
      sourceRef?.id !== undefined &&
      String(sourceRef.id) === String(targetRef?.id)
    ) {
      selfLoopNodeIds.add(String(sourceRef.id));
    }
  }

  const newYByNodeId = new Map<string, number>();
  const laneRects: { lane: ModdleElement; bounds: Bounds }[] = [];
  let cursorY = DIAGRAM_PADDING;

  const stackBand = (ids: string[]): number => {
    const band = planBand(ids.map((id) => boundsByNodeId.get(id) as Bounds));
    const rowHeight = Math.max(...band.rowHeights, 0);
    const loopSpace = ids.some((id) => selfLoopNodeIds.has(id))
      ? SELF_LOOP_OFFSET
      : 0;
    const contentHeight =
      LANE_PADDING_Y * 2 +
      band.rowHeights.length * rowHeight +
      Math.max(0, band.rowHeights.length - 1) * LANE_ROW_GAP +
      loopSpace;
    const height = Math.max(MIN_LANE_HEIGHT, contentHeight);
    // A lane can be taller than its content, so keep the nodes centred.
    const contentTop = cursorY + (height - contentHeight) / 2;

    band.slots.forEach((slot, index) => {
      newYByNodeId.set(
        ids[index],
        contentTop +
          LANE_PADDING_Y +
          slot.row * (rowHeight + LANE_ROW_GAP) +
          (rowHeight - slot.height) / 2,
      );
    });

    cursorY += height;
    return height;
  };

  lanes.forEach((lane, index) => {
    const ids = orderedIds(index);
    const top = cursorY;
    const height = stackBand(ids);

    laneRects.push({
      lane,
      bounds: {
        x: laneLeft,
        y: top,
        width: laneWidth,
        height,
      },
    });
  });

  const unassigned = [...boundsByNodeId.keys()].filter(
    (id) => !laneIndexByNodeId.has(id),
  );

  if (unassigned.length > 0) {
    stackBand(unassigned);
  }

  for (const element of planeElements) {
    const businessObject = element.get("bpmnElement") as ModdleElement | undefined;

    if (businessObject === undefined || isLabelShape(element)) {
      continue;
    }

    const bounds = readBounds(element);
    const id = String(businessObject.id);
    const newY = newYByNodeId.get(id);

    if (bounds && newY !== undefined) {
      bounds.x += deltaX;
      bounds.y = newY;
    }
  }

  const centerOf = (id: string | undefined): { x: number; y: number } | null => {
    const bounds = id === undefined ? undefined : boundsByNodeId.get(id);

    if (!bounds) {
      return null;
    }

    return {
      x: bounds.x,
      y: newYByNodeId.get(String(id)) ?? bounds.y,
    };
  };

  type Point = { x: number; y: number };

  const point = (x: number, y: number): ModdleElement =>
    moddle.create("dc:Point", { x, y });
  const waypointsOf = (points: Point[]): ModdleElement[] =>
    points.map((entry) => point(entry.x, entry.y));
  const collinearOverlap = (
    from: Point,
    to: Point,
    otherFrom: Point,
    otherTo: Point,
  ): number => {
    if (from.y === to.y) {
      if (otherFrom.y !== otherTo.y || Math.abs(from.y - otherFrom.y) > 1) {
        return 0;
      }

      const low = Math.max(
        Math.min(from.x, to.x),
        Math.min(otherFrom.x, otherTo.x),
      );
      const high = Math.min(Math.max(from.x, to.x), Math.max(otherFrom.x, otherTo.x));

      return high - low;
    }

    if (otherFrom.x !== otherTo.x || Math.abs(from.x - otherFrom.x) > 1) {
      return 0;
    }

    const low = Math.max(
      Math.min(from.y, to.y),
      Math.min(otherFrom.y, otherTo.y),
    );
    const high = Math.min(Math.max(from.y, to.y), Math.max(otherFrom.y, otherTo.y));

    return high - low;
  };
  const segmentHitsBox = (
    from: { x: number; y: number },
    to: { x: number; y: number },
    box: Bounds,
  ): boolean => {
    const left = box.x - EDGE_CLEARANCE;
    const right = box.x + box.width + EDGE_CLEARANCE;
    const top = box.y - EDGE_CLEARANCE;
    const bottom = box.y + box.height + EDGE_CLEARANCE;

    if (from.x === to.x) {
      return (
        from.x > left &&
        from.x < right &&
        Math.max(from.y, to.y) > top &&
        Math.min(from.y, to.y) < bottom
      );
    }

    return (
      from.y > top &&
      from.y < bottom &&
      Math.max(from.x, to.x) > left &&
      Math.min(from.x, to.x) < right
    );
  };
  const obstacles = [...boundsByNodeId.entries()];
  const placedSegments: Array<[Point, Point]> = [];
  const routeIsClear = (
    points: Point[],
    sourceId: string,
    targetId: string,
  ): boolean =>
    points.every((entry, index) => {
      if (index === 0) {
        return true;
      }

      const previous = points[index - 1]!;

      return !obstacles.some(
        ([id, box]) =>
          id !== sourceId &&
          id !== targetId &&
          segmentHitsBox(previous, entry, box),
      );
    });
  const routeIsFree = (points: Point[]): boolean =>
    points.every((entry, index) => {
      if (index === 0) {
        return true;
      }

      const previous = points[index - 1]!;

      return !placedSegments.some(
        ([from, to]) =>
          collinearOverlap(previous, entry, from, to) > EDGE_OVERLAP_TOLERANCE,
      );
    });
  const routeIsUsable = (
    points: Point[],
    sourceId: string,
    targetId: string,
  ): boolean => routeIsClear(points, sourceId, targetId) && routeIsFree(points);
  const rememberRoute = (points: Point[]): void => {
    for (let index = 0; index + 1 < points.length; index++) {
      placedSegments.push([points[index]!, points[index + 1]!]);
    }
  };
  const isClearChannel = (
    x: number,
    fromY: number,
    toY: number,
    sourceId: string,
    targetId: string,
  ): boolean =>
    routeIsClear(
      [
        { x, y: fromY },
        { x, y: toY },
      ],
      sourceId,
      targetId,
    );
  const freeChannels = (
    fromX: number,
    toX: number,
    fromY: number,
    toY: number,
    sourceId: string,
    targetId: string,
  ): number[] => {
    const left = Math.min(fromX, toX);
    const right = Math.max(fromX, toX);
    const span = [
      Math.min(fromY, toY) - EDGE_CLEARANCE,
      Math.max(fromY, toY) + EDGE_CLEARANCE,
    ] as const;
    const blockers = obstacles
      .filter(
        ([id, box]) =>
          id !== sourceId &&
          id !== targetId &&
          box.x + box.width + EDGE_CLEARANCE > left &&
          box.x - EDGE_CLEARANCE < right &&
          box.y + box.height + EDGE_CLEARANCE > span[0] &&
          box.y - EDGE_CLEARANCE < span[1],
      )
      .map(([, box]) => [box.x - EDGE_CLEARANCE, box.x + box.width + EDGE_CLEARANCE])
      .sort((a, b) => a[0]! - b[0]!);
    const channels: number[] = [];

    let cursor = left;

    for (const [start, end] of blockers) {
      if (start > cursor) {
        channels.push(Math.round((cursor + start) / 2));
      }

      cursor = Math.max(cursor, end);
    }

    if (cursor < right) {
      channels.push(Math.round((cursor + right) / 2));
    }

    // Also try positions just inside the endpoints. Concurrent flows out of one
    // node would otherwise all pick the same gap centre and overlap.
    const ideal = (left + right) / 2;
    // Scale the spread to the corridor width so long-distance flows also get
// enough distinct channels.
    const corridor = right - left;
    const steps = Math.max(
      CHANNEL_STEPS,
      Math.min(CHANNEL_MAX_STEPS, Math.floor(corridor / EDGE_SPACING)),
    );
    const idealCandidates: number[] = [];

    for (let step = 1; step <= steps; step++) {
      idealCandidates.push(
        Math.round(ideal - (step * corridor) / (2 * steps)),
        Math.round(ideal + (step * corridor) / (2 * steps)),
      );
    }

    const candidates = [...channels, ...idealCandidates]
      .filter((x, index, all) => all.indexOf(x) === index)
      .filter((x) => x >= left - 1 && x <= right + 1)
      .sort((a, b) => {
        const freeA = isClearChannel(a, fromY, toY, sourceId, targetId) ? 0 : 1;
        const freeB = isClearChannel(b, fromY, toY, sourceId, targetId) ? 0 : 1;

        if (freeA !== freeB) {
          return freeA - freeB;
        }

        return Math.abs(a - ideal) - Math.abs(b - ideal);
      });

    return candidates;
  };

  type EdgePlan = {
    element: ModdleElement;
    sourceId: string;
    targetId: string;
    sourceBounds: Bounds;
    targetBounds: Bounds;
    isBackward: boolean;
    startX: number;
    startY: number;
    endX: number;
    endY: number;
  };

  const edgePlans: EdgePlan[] = [];

  for (const element of planeElements) {
    if (element.$type !== "bpmndi:BPMNEdge") {
      continue;
    }

    const semantic = element.get("bpmnElement") as ModdleElement | undefined;
    const sourceRef = semantic?.get("sourceRef") as ModdleElement | undefined;
    const targetRef = semantic?.get("targetRef") as ModdleElement | undefined;
    const source = centerOf(sourceRef?.id === undefined ? undefined : String(sourceRef.id));
    const target = centerOf(targetRef?.id === undefined ? undefined : String(targetRef.id));

    if (!source || !target) {
      continue;
    }

    edgePlans.push({
      element,
      sourceId: String(sourceRef?.id),
      targetId: String(targetRef?.id),
      sourceBounds: boundsByNodeId.get(String(sourceRef?.id)) as Bounds,
      targetBounds: boundsByNodeId.get(String(targetRef?.id)) as Bounds,
      isBackward: false,
      startX: 0,
      startY: 0,
      endX: 0,
      endY: 0,
    });
  }

  /**
   * Several flows attach to the same node. If every one of them docks at the
   * node centre their approach segments lie on top of each other, so the anchor
   * points are spread over the node edge instead.
   */
  const spreadAnchors = (
    plans: EdgePlan[],
    pick: (plan: EdgePlan) => { key: string; box: Bounds; partnerY: number },
    apply: (plan: EdgePlan, y: number) => void,
  ): void => {
    const groups = new Map<string, Array<{ plan: EdgePlan; partnerY: number }>>();

    for (const plan of plans) {
      const { key, partnerY } = pick(plan);
      const group = groups.get(key);

      if (group) {
        group.push({ plan, partnerY });
      } else {
        groups.set(key, [{ plan, partnerY }]);
      }
    }

    for (const group of groups.values()) {
      const sorted = [...group].sort((a, b) => a.partnerY - b.partnerY);
      const bounds = pick(sorted[0]!.plan).box;
      const count = sorted.length;

      if (count === 1) {
        apply(sorted[0]!.plan, Math.round(bounds.y + bounds.height / 2));
        continue;
      }

      sorted.forEach((entry, index) => {
        const fraction = (index + 1) / (count + 1);
        apply(entry.plan, Math.round(bounds.y + bounds.height * fraction));
      });
    }
  };

  spreadAnchors(
    edgePlans,
    (plan) => ({
      key: `${plan.sourceId}:out:${plan.isBackward ? "left" : "right"}`,
      box: plan.sourceBounds,
      partnerY: plan.targetBounds.y + plan.targetBounds.height / 2,
    }),
    (plan, y) => {
      plan.startY = y;
    },
  );

  for (const plan of edgePlans) {
    plan.isBackward =
      plan.targetBounds.x < plan.sourceBounds.x + plan.sourceBounds.width;
  }

  spreadAnchors(
    edgePlans,
    (plan) => ({
      key: `${plan.targetId}:in:${plan.isBackward ? "right" : "left"}`,
      box: plan.targetBounds,
      partnerY: plan.sourceBounds.y + plan.sourceBounds.height / 2,
    }),
    (plan, y) => {
      plan.endY = y;
    },
  );

  for (const plan of edgePlans) {
    plan.startX = Math.round(
      plan.isBackward ? plan.sourceBounds.x : plan.sourceBounds.x + plan.sourceBounds.width,
    );
    plan.endX = Math.round(
      plan.isBackward
        ? plan.targetBounds.x + plan.targetBounds.width
        : plan.targetBounds.x,
    );
  }

  for (const plan of edgePlans) {
    const {
      element,
      sourceId,
      targetId,
      sourceBounds,
      startX,
      startY,
      endX,
      endY,
    } = plan;
    const source = centerOf(sourceId);
    const target = centerOf(targetId);

    if (!source || !target) {
      continue;
    }

    if (sourceId === targetId) {
      const loopRight = Math.round(source.x + sourceBounds.width + SELF_LOOP_OFFSET);
      const loopBottom = Math.round(
        source.y + sourceBounds.height + SELF_LOOP_OFFSET,
      );
      const centerX = Math.round(source.x + sourceBounds.width / 2);

      element.set(
        "waypoint",
        waypointsOf([
          { x: Math.round(source.x + sourceBounds.width), y: startY },
          { x: loopRight, y: startY },
          { x: loopRight, y: loopBottom },
          { x: centerX, y: loopBottom },
          { x: centerX, y: Math.round(source.y + sourceBounds.height) },
        ]),
      );
      continue;
    }

    if (Math.abs(startY - endY) <= 1) {
      const straight: Point[] = [
        { x: startX, y: startY },
        { x: endX, y: endY },
      ];

      if (routeIsUsable(straight, sourceId, targetId)) {
        rememberRoute(straight);
        element.set("waypoint", waypointsOf(straight));
        continue;
      }
    }

    const channels = freeChannels(
      startX,
      endX,
      startY,
      endY,
      sourceId,
      targetId,
    );
    const route = channels
      .map<Point[]>((x) => [
        { x: startX, y: startY },
        { x, y: startY },
        { x, y: endY },
        { x: endX, y: endY },
      ])
      .find((candidate) => routeIsUsable(candidate, sourceId, targetId));

    if (route) {
      rememberRoute(route);
      element.set("waypoint", waypointsOf(route));
      continue;
    }

    // Last resort: pick any vertical channel between the endpoints that does not
    // cut through a node, so a fallback route never lands on a shape border.
    const fallbackChannels = obstacles
      .filter(
        ([id, box]) =>
          id !== sourceId &&
          id !== targetId &&
          box.y + box.height + EDGE_CLEARANCE > Math.min(startY, endY) &&
          box.y - EDGE_CLEARANCE < Math.max(startY, endY),
      )
      .map(([, box]) => [box.x - EDGE_CLEARANCE, box.x + box.width + EDGE_CLEARANCE])
      .sort((a, b) => a[0]! - b[0]!);

    const searchLeft = Math.min(startX, endX);
    const searchRight = Math.max(startX, endX);
    const gaps: number[] = [];
    let cursor = searchLeft;

    for (const [from, to] of fallbackChannels) {
      const low = Math.max(from, searchLeft);
      const high = Math.min(to, searchRight);

      if (high > low) {
        if (low > cursor) {
          gaps.push(Math.round((cursor + low) / 2));
        }
        cursor = Math.max(cursor, high);
      }
    }

    if (cursor < searchRight) {
      gaps.push(Math.round((cursor + searchRight) / 2));
    }

    const fallbackX =
      gaps.find(
        (x) =>
          routeIsUsable(
            [
              { x: startX, y: startY },
              { x, y: startY },
              { x, y: endY },
              { x: endX, y: endY },
            ],
            sourceId,
            targetId,
          ),
      ) ?? Math.round((startX + endX) / 2);
    const fallback: Point[] = [
      { x: startX, y: startY },
      { x: fallbackX, y: startY },
      { x: fallbackX, y: endY },
      { x: endX, y: endY },
    ];

    rememberRoute(fallback);
    element.set("waypoint", waypointsOf(fallback));
  }

  const laneShapes = laneRects.map(({ lane, bounds }) =>
    moddle.create("bpmndi:BPMNShape", {
      id: `${String(lane.id)}_di`,
      bpmnElement: lane,
      isHorizontal: true,
      bounds: moddle.create("dc:Bounds", {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      }),
    }),
  );

  const keptElements = planeElements.filter((element) => {
    const businessObject = element.get("bpmnElement") as ModdleElement | undefined;
    return businessObject === undefined || !laneIds.has(String(businessObject.id));
  });

  plane.set("planeElement", [...laneShapes, ...keptElements]);

  const { xml: laneXml } = await moddle.toXML(definitions, { format: true });
  return laneXml;
}
export async function diagramToLaidOutXml(value: unknown): Promise<string> {
  const input = parseDiagramInput(value);
  const rawXml = await buildBpmnXml(input);
  return await layoutBpmnXml(rawXml);
}