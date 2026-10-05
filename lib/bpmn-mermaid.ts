import { BpmnModdle, ModdleElement } from "bpmn-moddle";

/**
 * Mermaid has fewer shapes than BPMN, so several BPMN element types share a
 * rendering. The mapping is documented in the README.
 */
const NODE_SHAPE_BY_TYPE: Record<string, string> = {
  "bpmn:StartEvent": '([{label}])',
  "bpmn:EndEvent": '(({label}))',
  "bpmn:IntermediateThrowEvent": "({label})",
  "bpmn:IntermediateCatchEvent": "({label})",
  "bpmn:ExclusiveGateway": "{{" + "{label}" + "}}",
  "bpmn:InclusiveGateway": "{{" + "{label}" + "}}",
  "bpmn:ParallelGateway": "{{" + "{label}" + "}}",
  "bpmn:ComplexGateway": "{{" + "{label}" + "}}",
  "bpmn:EventBasedGateway": "{{" + "{label}" + "}}",
  "bpmn:Task": '[{label}]',
  "bpmn:UserTask": '[{label}]',
  "bpmn:ManualTask": '[{label}]',
  "bpmn:ServiceTask": '[[{label}]]',
  "bpmn:SendTask": '[[{label}]]',
  "bpmn:ReceiveTask": '[[{label}]]',
  "bpmn:ScriptTask": '[/{label}/]',
  "bpmn:BusinessRuleTask": '[/{label}/]',
  "bpmn:SubProcess": '[[{label}]]',
  "bpmn:CallActivity": '[[{label}]]',
  "bpmn:DataObjectReference": '[({label})]',
  "bpmn:DataStoreReference": '[({label})]',
};

const DEFAULT_NODE_SHAPE = '[{label}]';

const MERMAID_RESERVED_IDS = new Set([
  "end",
  "graph",
  "subgraph",
  "class",
  "classDef",
  "click",
  "style",
  "linkStyle",
  "direction",
]);

const FALLBACK_LANE_ID = "__no_lane__";
const FALLBACK_LANE_NAME = "Ohne Lane";
const FALLBACK_SUBGRAPH_ID = "s_nodes_without_lane";

/**
 * Mermaid reads `#word;` as an entity reference, so a literal `#` has to be
 * escaped before it reaches the renderer.
 */
function escapeLabel(value: string): string {
  return (
    value
      // Literal `#` first, otherwise the entity codes added below would be
      // escaped a second time.
      .replace(/#(?=[A-Za-z][A-Za-z0-9]*;)/g, "#35;")
      .replace(/"/g, "#quot;")
      // `<` and `>` would otherwise be read as HTML inside the quoted label.
      .replace(/</g, "#lt;")
      .replace(/>/g, "#gt;")
      .replace(/\s*[\r\n]+\s*/g, " ")
      .trim()
  );
}

function toIdentifier(raw: string, prefix: string): string {
  const sanitized = raw.replace(/[^A-Za-z0-9_]/g, "_");
  const candidate = sanitized.length === 0 ? prefix : `${prefix}${sanitized}`;

  if (/^[0-9]/.test(candidate)) {
    return `${prefix}_${candidate}`;
  }

  return MERMAID_RESERVED_IDS.has(candidate.toLowerCase())
    ? `${candidate}_${prefix.trim().toLowerCase()}`
    : candidate;
}

function labelOf(element: ModdleElement): string {
  const name = element.get("name");

  if (typeof name === "string" && name.trim().length > 0) {
    return escapeLabel(name);
  }

  return escapeLabel(String(element.id ?? ""));
}

function shapeOf(element: ModdleElement): string {
  const template = NODE_SHAPE_BY_TYPE[element.$type] ?? DEFAULT_NODE_SHAPE;

  // Labels are always quoted, so spaces, quotes and punctuation are safe.
  return template.replace("{label}", `"${labelOf(element)}"`);
}

function lanesOf(process: ModdleElement): ModdleElement[] {
  const laneSets = (process.get("laneSets") as ModdleElement[] | undefined) ?? [];
  const lanes = (laneSets[0]?.get("lanes") as ModdleElement[] | undefined) ?? [];

  return lanes.filter((lane) => String(lane.$type) === "bpmn:Lane");
}

function pickProcess(rootElements: ModdleElement[]): ModdleElement | null {
  const processes = rootElements.filter(
    (element) => String(element.$type) === "bpmn:Process",
  );

  if (processes.length === 0) {
    return null;
  }

  // Prefer the process the diagram plane actually renders, so an exported file
  // with several processes describes the one the user sees.
  const planeProcess = processes.find((process) =>
    (process.get("flowElements") as ModdleElement[] | undefined)?.some(
      (flowElement) =>
        String(flowElement.get("di")) !== "undefined" &&
        (flowElement.get("di") as ModdleElement | undefined)?.$type ===
          "bpmndi:BPMNShape",
    ),
  );

  return planeProcess ?? processes[0] ?? null;
}

/**
 * Converts a BPMN 2.0 XML document into a Mermaid `flowchart` definition.
 *
 * Lanes become subgraphs, flow nodes keep their document order, and sequence
 * flow names (the `condition` in the JSON input) become edge labels. The
 * result is meant for a ```mermaid fence in GitHub or GitLab Markdown.
 */
export async function bpmnXmlToMermaid(xml: string): Promise<string> {
  const moddle = new BpmnModdle();
  const { rootElement } = await moddle.fromXML(xml);

  const rootElements =
    (rootElement.get("rootElements") as ModdleElement[] | undefined) ?? [];
  const process = pickProcess(rootElements);

  if (!process) {
    throw new Error("The diagram XML does not contain a BPMN process.");
  }

  const flowElements =
    (process.get("flowElements") as ModdleElement[] | undefined) ?? [];
  const nodes = flowElements.filter(
    (element) => String(element.$type) !== "bpmn:SequenceFlow",
  );
  const flows = flowElements.filter(
    (element) => String(element.$type) === "bpmn:SequenceFlow",
  );

  const identifierById = new Map<string, string>();

  for (const node of nodes) {
    identifierById.set(String(node.id), toIdentifier(String(node.id), "n_"));
  }

  const lanes = lanesOf(process);
  const laneIdByNodeId = new Map<string, string>();

  for (const lane of lanes) {
    const members = (lane.get("flowNodeRef") as ModdleElement[] | undefined) ?? [];

    for (const member of members) {
      laneIdByNodeId.set(String(member.id), String(lane.id));
    }
  }

  const groupByLane = new Map<string, ModdleElement[]>();

  for (const node of nodes) {
    const key = laneIdByNodeId.get(String(node.id)) ?? FALLBACK_LANE_ID;
    const group = groupByLane.get(key);

    if (group) {
      group.push(node);
    } else {
      groupByLane.set(key, [node]);
    }
  }

  const lines: string[] = [];
  const processName = process.get("name");

  if (typeof processName === "string" && processName.trim().length > 0) {
    lines.push(`%% ${escapeLabel(processName)}`, "");
  }

  lines.push("flowchart LR");

  const nodeLine = (node: ModdleElement): string => {
    const id = identifierById.get(String(node.id)) as string;

    return `    ${id}${shapeOf(node)}`;
  };

  const orderedLaneIds = [
    ...lanes.map((lane) => String(lane.id)),
    ...(groupByLane.has(FALLBACK_LANE_ID) ? [FALLBACK_LANE_ID] : []),
  ];

  for (const laneId of orderedLaneIds) {
    const members = groupByLane.get(laneId) ?? [];
    const lane = lanes.find((candidate) => String(candidate.id) === laneId);
    const name =
      laneId === FALLBACK_LANE_ID
        ? FALLBACK_LANE_NAME
        : labelOf(lane as ModdleElement);

    if (members.length === 0) {
      lines.push(`  %% Lane "${name}" has no elements`);
      continue;
    }

    const subgraphId =
      laneId === FALLBACK_LANE_ID
        ? FALLBACK_SUBGRAPH_ID
        : toIdentifier(laneId, "s_");

    lines.push(`  subgraph ${subgraphId}["${name}"]`);
    lines.push(members.map(nodeLine).join("\n"));
    lines.push("  end");
  }

  if (flows.length > 0) {
    lines.push("");

    for (const flow of flows) {
      const sourceRef = flow.get("sourceRef") as ModdleElement | undefined;
      const targetRef = flow.get("targetRef") as ModdleElement | undefined;

      if (!sourceRef || !targetRef) {
        continue;
      }

      const source = identifierById.get(String(sourceRef.id));
      const target = identifierById.get(String(targetRef.id));

      if (!source || !target) {
        continue;
      }

      const name = flow.get("name");
      const arrow =
        typeof name === "string" && name.trim().length > 0
          ? `${source} -->|"${escapeLabel(name)}"| ${target}`
          : `${source} --> ${target}`;

      lines.push(`  ${arrow}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

/** Wraps Mermaid code in a Markdown fence for pasting into GitHub or GitLab. */
export function toMermaidMarkdown(mermaid: string): string {
  return ["```mermaid", mermaid.trimEnd(), "```", ""].join("\n");
}