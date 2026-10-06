"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ChangeEvent, KeyboardEvent } from "react";
import type Canvas from "diagram-js/lib/core/Canvas";
import {
  DiagramInputError,
  buildBpmnXml,
  extractJsonPayload,
  layoutBpmnXml,
  parseDiagramInput,
} from "@/lib/bpmn-diagram";
import { lintDiagramInput } from "@/lib/bpmn-lint";
import type { LintIssue } from "@/lib/bpmn-lint";
import "bpmn-js/dist/assets/diagram-js.css";
import "bpmn-js/dist/assets/bpmn-js.css";
import "bpmn-js/dist/assets/bpmn-font/css/bpmn.css";

type BpmnModelerInstance = InstanceType<
  (typeof import("bpmn-js/lib/Modeler"))["default"]
>;

type ResettableModeler = BpmnModelerInstance & { clear(): void };

type DiagramFormat = "bpmn" | "xml";

const IMAGE_SCALE = 2;

type Status = "idle" | "busy" | "ready" | "error";

type RenderSummary = {
  fileName: string;
  origin: "generated" | "imported";
  nodes: number | null;
  edges: number | null;
  lanes: number | null;
};

type OutputLanguage = "en" | "de";

const OUTPUT_LANGUAGE_STORAGE_KEY = "flowsmith.outputLanguage";
const OUTPUT_LANGUAGE_EVENT = "flowsmith.outputLanguageChange";
const DEFAULT_OUTPUT_LANGUAGE: OutputLanguage = "en";
const OUTPUT_LANGUAGES: readonly OutputLanguage[] = ["en", "de"];

function readStoredOutputLanguage(): OutputLanguage {
  try {
    const stored = window.localStorage.getItem(OUTPUT_LANGUAGE_STORAGE_KEY);

    if (stored !== null && OUTPUT_LANGUAGES.includes(stored as OutputLanguage)) {
      return stored as OutputLanguage;
    }
  } catch {
    // Storage can be unavailable (private mode, blocked cookies); the default stands.
  }

  return DEFAULT_OUTPUT_LANGUAGE;
}

function subscribeToOutputLanguage(onStoreChange: () => void): () => void {
  // "storage" covers other tabs; the custom event covers this tab, because a
  // localStorage write never notifies its own writer.
  window.addEventListener("storage", onStoreChange);
  window.addEventListener(OUTPUT_LANGUAGE_EVENT, onStoreChange);

  return () => {
    window.removeEventListener("storage", onStoreChange);
    window.removeEventListener(OUTPUT_LANGUAGE_EVENT, onStoreChange);
  };
}

function storeOutputLanguage(language: OutputLanguage): void {
  try {
    window.localStorage.setItem(OUTPUT_LANGUAGE_STORAGE_KEY, language);
  } catch {
    // A failed write only costs us the persistence, not the setting itself.
  }

  window.dispatchEvent(new Event(OUTPUT_LANGUAGE_EVENT));
}

/**
 * The prompt itself always stays English — only the language of the labels the
 * LLM is asked to produce is switched, because rule numbering and the schema
 * must not drift between the two variants.
 */
type PromptLanguageRules = {
  placeholder: string;
  labelRule: string;
  conditionRule: string;
  labelStyleRule: string;
  processNameRule: string;
  roleExamples: string;
  systemExamples: string;
  granularityExample: string;
  example: JsonExampleLabels;
};

type JsonExampleLabels = {
  processId: string;
  processName: string;
  lanes: readonly [string, string, string];
  nodes: readonly [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  conditions: readonly [string, string];
};

const EN_EXAMPLE: JsonExampleLabels = {
  processId: "Process_RequestReview",
  processName: "Request review",
  lanes: ["Case worker", "Department management", "Ordering system"],
  nodes: [
    "Request received",
    "Review request",
    "Request valid?",
    "Grant approval",
    "Create order",
    "Order database",
    "Process completed",
  ],
  conditions: ["Yes", "No"],
};

const DE_EXAMPLE: JsonExampleLabels = {
  processId: "Process_Antragspruefung",
  processName: "Antragsprüfung",
  lanes: ["Sachbearbeiter", "Fachbereichsleitung", "Bestellsystem"],
  nodes: [
    "Antrag eingegangen",
    "Antrag prüfen",
    "Antrag gültig?",
    "Freigabe erteilen",
    "Bestellung anlegen",
    "Auftragsdatenbank",
    "Prozess abgeschlossen",
  ],
  conditions: ["Ja", "Nein"],
};

const PROMPT_LANGUAGE_RULES: Record<OutputLanguage, PromptLanguageRules> = {
  en: {
    placeholder: "[[PROCESS DESCRIPTION]]",
    labelRule:
      "11. Every human-readable string (processName, lane names, node labels, edge conditions) MUST be written in ENGLISH. Only those strings use English — this instruction and your reasoning stay in English.",
    conditionRule:
      '19. An "exclusiveGateway" has at least two outgoing edges. EACH of them MUST carry a "condition" in English (for example "Yes", "No", "Valid", "Amount over 1,000 EUR"), and the conditions must be mutually exclusive and together cover every case.',
    labelStyleRule:
      '22. Keep labels short: at most five words, no quotation marks, no line breaks, no markup. Tasks as verb plus object ("Review request"), gateways as a question ("Request valid?"), events as a completed state ("Request received", "Process completed").',
    processNameRule:
      '24. "processId" is an XML-safe identifier: starts with a letter, contains only letters, digits, and underscores, no spaces. "processName" is the English process name in the singular.',
    roleExamples: '"Case worker", "Team lead", "Admins", "Accounting"',
    systemExamples: '"Ordering system", "Mail service", "Cronjob"',
    granularityExample:
      'one method "createOrder" that validates the input, reserves stock and triggers the payment becomes THREE nodes ("Validate input data", "Reserve stock", "Trigger payment"), never the single node "Create order".',
    example: EN_EXAMPLE,
  },
  de: {
    placeholder: "[[PROZESSBESCHREIBUNG]]",
    labelRule:
      "11. Every human-readable string (processName, lane names, node labels, edge conditions) MUST be written in GERMAN. Only those strings use German — this instruction and your reasoning stay in English.",
    conditionRule:
      '19. An "exclusiveGateway" has at least two outgoing edges. EACH of them MUST carry a "condition" in German (for example "Ja", "Nein", "Gültig", "Betrag über 1.000 Euro"), and the conditions must be mutually exclusive and together cover every case.',
    labelStyleRule:
      '22. Keep labels short: at most five words, no quotation marks, no line breaks, no markup. Tasks as verb plus object ("Antrag prüfen"), gateways as a question ("Antrag gültig?"), events as a completed state ("Antrag eingegangen", "Prozess abgeschlossen").',
    processNameRule:
      '24. "processId" is an XML-safe identifier: starts with a letter, contains only letters, digits, and underscores, no spaces. "processName" is the German process name in the singular.',
    roleExamples: '"Sachbearbeiter", "Teamleiter", "Admins", "Buchhaltung"',
    systemExamples: '"Bestellsystem", "Mailversand", "Cronjob"',
    granularityExample:
      'one method "Bestellung anlegen" that validates the input, reserves stock and triggers the payment becomes THREE nodes ("Eingangsdaten validieren", "Bestand reservieren", "Zahlung auslösen"), never the single node "Bestellung anlegen".',
    example: DE_EXAMPLE,
  },
};

function buildJsonExample(labels: JsonExampleLabels): string {
  return `{
  "processId": "${labels.processId}",
  "processName": "${labels.processName}",
  "lanes": [
    { "id": "lane_1", "name": "${labels.lanes[0]}" },
    { "id": "lane_2", "name": "${labels.lanes[1]}" },
    { "id": "lane_3", "name": "${labels.lanes[2]}" }
  ],
  "nodes": [
    { "id": "start_1", "type": "startEvent", "label": "${labels.nodes[0]}", "laneId": "lane_1" },
    { "id": "task_1", "type": "userTask", "label": "${labels.nodes[1]}", "laneId": "lane_1" },
    { "id": "gw_1", "type": "exclusiveGateway", "label": "${labels.nodes[2]}", "laneId": "lane_1" },
    { "id": "task_2", "type": "userTask", "label": "${labels.nodes[3]}", "laneId": "lane_2" },
    { "id": "task_3", "type": "serviceTask", "label": "${labels.nodes[4]}", "laneId": "lane_3" },
    { "id": "store_1", "type": "dataStoreReference", "label": "${labels.nodes[5]}" },
    { "id": "end_1", "type": "endEvent", "label": "${labels.nodes[6]}", "laneId": "lane_1" }
  ],
  "edges": [
    { "id": "e1", "sourceId": "start_1", "targetId": "task_1" },
    { "id": "e2", "sourceId": "task_1", "targetId": "gw_1" },
    { "id": "e3", "sourceId": "gw_1", "targetId": "task_2", "condition": "${labels.conditions[0]}" },
    { "id": "e4", "sourceId": "gw_1", "targetId": "end_1", "condition": "${labels.conditions[1]}" },
    { "id": "e5", "sourceId": "task_2", "targetId": "task_3" },
    { "id": "e6", "sourceId": "task_3", "targetId": "end_1" }
  ],
  "dataAssociations": [
    { "id": "da1", "nodeId": "task_1", "dataNodeId": "store_1", "direction": "read" },
    { "id": "da2", "nodeId": "task_3", "dataNodeId": "store_1", "direction": "write" }
  ]
}`;
}

function buildSystemPrompt(language: OutputLanguage): string {
  const rules = PROMPT_LANGUAGE_RULES[language];

  return `You are a high-precision systems architect specializing in Business Process Model and Notation (BPMN 2.0).
Your single task: turn a real-world business process into a strictly valid JSON object. That JSON is converted automatically into BPMN 2.0 XML, laid out automatically, and rendered as an editable diagram. Your final message must be that JSON and nothing else.

## 1. MANDATORY PROJECT EXPLORATION
Do NOT guess the process from general knowledge. Investigate the project first — this step is mandatory.
1. Use your file and search tools before you write anything: grep, glob and read. Map the project structure first, then drill into the files that implement the process.
2. Search for evidence of the process, for example: state machines and status enums, workflow and orchestration code, API routes, controllers and handlers, services, scheduled jobs and queue consumers, domain entities and database tables, role and permission definitions, notification or mail sending, existing BPMN/DMN files, and documentation.
3. Drive the search from the domain nouns of the request (entities, verbs, statuses, screens) and from the technical terms behind it. Read the files that actually contain the logic, not just the entry points.
4. Translate what you find into the model:
   - every concrete human role, external system, or service boundary becomes one lane with a specific name (see section 3b);
   - every distinct step of the real code path becomes one node, listed in execution order (section 3d defines what counts as distinct — this is where most diagrams fail);
   - every branch, decision, retry, escalation, approval, or parallel path becomes a gateway;
   - state transitions and status changes are the strongest signal for where nodes and gateways belong.
5. Prefer evidence over assumption. When the request and the code disagree, follow the code and adopt the reading that matches the real implementation.
6. Never invent steps, roles, or systems that neither the request nor the code supports. Fill a gap only when the request or the implementation makes it unavoidable.
7. If the project contains nothing relevant, work purely from the request.
Tool calls, file reads, and reasoning before you answer are allowed and expected — the flow it describes is how you find the process. None of that reasoning may ever appear in your final message; the output rules in section 2 apply to that final message alone.

## 2. HARD OUTPUT RULES
8. Reply with EXACTLY ONE JSON object and nothing else. The first character of your final message must be "{" and the last character must be "}". Never open with a sentence, never write "Based on", "Here is", "Sure", "I found", "Note" or similar, and never append a summary, explanation, or file list after the closing brace.
9. No comments, no commented-out lines, no trailing comma after the last entry, no single quotes — double quotes only.
10. Use exactly the keys defined below. No additional fields, no renamed fields, no nested objects.
${rules.labelRule}
12. Keep all technical identifiers in English ASCII. IDs must never contain umlauts, ß, spaces, or hyphens.
13. If the description is ambiguous, choose the most plausible domain assumption and do not comment on it.

## 3. SEMANTIC RULES
14. Exactly one "startEvent" per process. It is the only node without an incoming edge.
15. At least one "endEvent". Every node must reach an "endEvent" through at least one path.
16. Every node must be reachable from the "startEvent". No isolated nodes, no dangling nodes, no cycles, and no backward edges unless the description or the evidence explicitly states a loop (see section 3d).
17. Allowed node types are "startEvent", "endEvent", "userTask", "serviceTask", "exclusiveGateway", and "parallelGateway".
    - "userTask" = a manual action performed by a human.
    - "serviceTask" = an automated action performed by a system, script, job, or integration.
    - If the process strictly requires something else, use "subProcess" (nested process), "manualTask", "scriptTask", "sendTask", "receiveTask", or "businessRuleTask". Do not use any type beyond these.
18. Every node needs a "laneId" that references a lane from the "lanes" array. Every lane must contain at least one node — empty lanes are forbidden.

## 3b. ROLES AND LANES
- Lanes are rendered as real BPMN swimlanes. The "lanes" array therefore describes who acts, not just a grouping.
- At least one lane MUST be a concrete human role taken from the project (for example ${rules.roleExamples}). A process with human work steps always has at least one human role lane.
- Name human lanes after the actual role found in the code — role enums, permission checks, authorisation decorators, admin flags, or controller guards. Derive the name from that evidence, not from the request wording alone.
- Name system lanes after the concrete actor: the service, job, queue, or integration that performs the work (for example ${rules.systemExamples}). Never merge different systems into one "System" lane.
- FORBIDDEN lane names: "Benutzer", "User", "Kunde", "Actor", "Participants", "Various", "Other", "Sonstige", "Unbekannt". Generic placeholders destroy the value of the swimlanes.
- Two lanes are only justified when the actors really differ. Do not invent an extra role to fill a gap, and do not split one role into several lanes.
- Every "userTask" MUST sit in a human role lane; every "serviceTask", "scriptTask", "sendTask", and "businessRuleTask" MUST sit in a system lane. Keep that mapping consistent.
- Put the lane of the acting role on every node, not the lane of the system that triggered the step.
- Order the lanes the way the process moves through them: receiving role first, then the roles that take over, with system lanes at the position where the automation happens.
${rules.conditionRule}
20. A "parallelGateway" used as a split has two or more outgoing edges WITHOUT a "condition".
21. Every edge needs a unique "id" plus "sourceId" and "targetId" that both reference existing nodes. A condition belongs to the edge's "condition" field only, never to a node label.
${rules.labelStyleRule}

## 3c. DATA AND DATA STORES
- "dataStoreReference" = a database, data warehouse, file store, or external system that persists data across process runs. "dataObjectReference" = a short-lived piece of information that only exists inside this process (a form, a generated PDF, a parsed payload).
- Add such a node ONLY when the description or the evidence really mentions that data. Never decorate a diagram with databases that play no role in the described process.
- A data node MUST NOT have a "laneId": a BPMN lane may only contain flow nodes (events, tasks, gateways), so data elements sit outside the lanes. Putting a database INTO a system lane is FORBIDDEN — model the system that USES the database as its own lane, and the database itself as a data node next to the steps that read or write it.
- A data node MUST NOT appear in "edges": a sequence flow only connects flow nodes. Use "dataAssociations" instead.
- "dataAssociations" links a step to a data node: { "id", "nodeId", "dataNodeId", "direction" }. "direction" is "read" when the step consumes the data and "write" when it produces data into it.
- Only "userTask", "serviceTask", "manualTask", "scriptTask", "sendTask", "receiveTask", "businessRuleTask", "subProcess", and "callActivity" may carry a data association. Events and gateways cannot.
- Every data node you add MUST be connected by at least one data association, and every data association MUST reference a data node that exists. An unexplained floating database is worse than no database.

## 3d. STEP DEPTH — THE PART THAT DECIDES QUALITY
A diagram is too coarse the moment one node stands for work the code visibly performs in several steps. Read method bodies, not just their names, and keep splitting until every node is one thing a person could name as a single action.
- One node is ONE concrete action with ONE clear outcome. If the label needs the word "and", or you cannot say what the node accomplishes, it is two nodes.
- Each of the following is a signal to emit a node of its own:
  - every status or state transition — an enum value written, a state machine transition, a status field or column changed;
  - every write that persists — save, insert, update, delete, transaction commit, file written;
  - every call that crosses a system boundary — HTTP or RPC client, queue publish, mail or SMS send, webhook call, file upload or download;
  - every wait — human approval, manual review, handoff to another role, waiting for a third party, a pending state;
  - every async continuation — scheduled job, queue consumer, callback, polling loop, event handler that resumes the work;
  - every iteration that performs real work per item.
- Each of the following is a signal to emit a gateway instead of a node: a validation that can fail, an authorisation or permission check, a branch on status, a retry limit, a timeout, a fallback, an escalation to a human, a rollback or compensation path.
- Split by evidence, never by imagination: ${rules.granularityExample} An if/else that can only ever take one branch is not a gateway, and no invented micro-step (for example "clear cache" or "write log entry") may become its own node.
- Loops and retries: an iteration or retry loop visible in the evidence justifies the exception in rule 16. Model it as a gateway with one loop-back edge, never as a second copy of the same nodes.
- A method whose name hides its work must be opened and read. If you only know the entry point and the method name, you do not know the process yet.
- Before you answer, verify silently against the files you actually read: every status enum value on the code path appears as a node or a gateway; every persistence call and every external call appears as a node; every failure branch appears as a gateway; every lane holds at least one node; no node label is a file, class, or module name. Fix the model until this holds. None of this verification may ever appear in your answer.

## 4. SCHEMA RULES
23. IDs are snake_case and may only contain a-z, 0-9, and "_": no spaces, no hyphens, no leading digit. IDs are unique across the whole JSON and carry a role prefix (start_1, task_1, gw_1, end_1, e1).
${rules.processNameRule}
25. Array order: "lanes" first, then "nodes" in execution order, then "edges", then "dataAssociations".
26. "dataAssociations" is optional. Omit the key entirely when the process has no data elements.

## 5. JSON SCHEMA
${buildJsonExample(rules.example)}

This example illustrates the structure only. Copy NONE of its content, ids, labels, or conditions. Model the process from the project evidence and the description at the end of this instruction.

## 6. PROCESS DESCRIPTION
Replace the placeholder line below with the business process to model, then output only the JSON:
${rules.placeholder}`;
}

/**
 * The guide names the same placeholder the prompt uses, so switching the
 * language never leaves the instructions pointing at a token that is not there.
 */
function buildGuideSteps(placeholder: string) {
  return [
    {
      title: "Copy the system prompt",
      description: `The button below puts the strict BPMN JSON prompt on your clipboard — replace ${placeholder} with your process description. The "Output language" selector decides whether the LLM writes the labels in English or German.`,
    },
    {
      title: "Paste it into your OpenCode LLM",
      description:
        "Send the prompt plus your process description to the LLM and let it return the JSON structure.",
    },
    {
      title: "Paste the JSON and generate",
      description:
        'Paste the JSON into the editor and click "Generate & Edit Diagram".',
    },
  ] as const;
}

function downloadBpmn(
  xml: string,
  fileName: string,
  format: DiagramFormat,
): void {
  downloadBlob(
    new Blob([xml], {
      type: format === "xml" ? "application/xml;charset=utf-8" : "application/bpmn20-xml;charset=utf-8",
    }),
    `${fileName.replace(/\.(bpmn|xml)$/i, "")}.${format}`,
  );
}

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function svgToPngBlob(svg: string, scale: number): Promise<Blob> {
  const image = new Image();
  const url = URL.createObjectURL(
    new Blob([svg], { type: "image/svg+xml;charset=utf-8" }),
  );

  try {
    const loaded = new Promise<void>((resolve, reject) => {
      image.onload = () => {
        resolve();
      };
      image.onerror = () => {
        reject(new Error("The diagram could not be rendered as an image."));
      };
    });

    image.src = url;
    await loaded;

    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;

    if (!width || !height) {
      throw new Error("The diagram has no size to export.");
    }

    const canvas = document.createElement("canvas");

    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));

    const context = canvas.getContext("2d");

    if (!context) {
      throw new Error("PNG export is not available in this browser.");
    }

    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.drawImage(image, 0, 0, width, height);

    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error("PNG export failed."));
        }
      }, "image/png");
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function copyToClipboard(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const scratch = document.createElement("textarea");
  scratch.value = text;
  scratch.setAttribute("readonly", "");
  scratch.style.position = "fixed";
  scratch.style.opacity = "0";
  document.body.append(scratch);
  scratch.select();

  const succeeded = document.execCommand("copy");
  scratch.remove();

  if (!succeeded) {
    throw new Error("Copying to the clipboard is not available.");
  }
}

const SAMPLE_INPUT = {
  processId: "Process_Antragspruefung",
  processName: "Antragsprüfung",
  lanes: [
    { id: "lane_1", name: "Sachbearbeiter" },
    { id: "lane_2", name: "Fachbereichsleitung" },
    { id: "lane_3", name: "Bestellsystem" },
  ],
  nodes: [
    {
      id: "start_1",
      type: "startEvent",
      label: "Antrag eingegangen",
      laneId: "lane_1",
    },
    {
      id: "task_1",
      type: "userTask",
      label: "Antrag prüfen",
      laneId: "lane_1",
    },
    {
      id: "gw_1",
      type: "exclusiveGateway",
      label: "Antrag gültig?",
      laneId: "lane_1",
    },
    {
      id: "task_2",
      type: "userTask",
      label: "Freigabe erteilen",
      laneId: "lane_2",
    },
    {
      id: "task_3",
      type: "serviceTask",
      label: "Bestellung anlegen",
      laneId: "lane_3",
    },
    {
      id: "end_1",
      type: "endEvent",
      label: "Prozess abgeschlossen",
      laneId: "lane_1",
    },
  ],
  edges: [
    { id: "e1", sourceId: "start_1", targetId: "task_1" },
    { id: "e2", sourceId: "task_1", targetId: "gw_1" },
    { id: "e3", sourceId: "gw_1", targetId: "task_2", condition: "Ja" },
    { id: "e4", sourceId: "gw_1", targetId: "end_1", condition: "Nein" },
    { id: "e5", sourceId: "task_2", targetId: "task_3" },
    { id: "e6", sourceId: "task_3", targetId: "end_1" },
  ],
} as const;

const DEFAULT_JSON = JSON.stringify(SAMPLE_INPUT, null, 2);

function describeError(thrown: unknown): string {
  if (thrown instanceof DiagramInputError) {
    return thrown.message;
  }
  if (thrown instanceof SyntaxError) {
    return `The input is not valid JSON — ${thrown.message}`;
  }
  if (thrown instanceof Error) {
    return thrown.message;
  }
  return "The diagram could not be generated.";
}

export default function BpmnFlowSmith() {
  const [jsonInput, setJsonInput] = useState(DEFAULT_JSON);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [lintIssues, setLintIssues] = useState<LintIssue[]>([]);
  const [summary, setSummary] = useState<RenderSummary | null>(null);
  const [modelerReady, setModelerReady] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [canvasEdited, setCanvasEdited] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [promptCopied, setPromptCopied] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // Read through an external store rather than in an effect: the page is
  // statically prerendered, so the server must keep seeing the default while
  // the client restores the stored choice.
  const outputLanguage = useSyncExternalStore(
    subscribeToOutputLanguage,
    readStoredOutputLanguage,
    () => DEFAULT_OUTPUT_LANGUAGE,
  );

  const containerRef = useRef<HTMLDivElement | null>(null);
  const modelerRef = useRef<BpmnModelerInstance | null>(null);
  const modelerPromiseRef = useRef<Promise<BpmnModelerInstance | null> | null>(
    null,
  );
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    let disposed = false;
    let instance: BpmnModelerInstance | null = null;

    modelerPromiseRef.current = (async () => {
      const { default: BpmnModeler } = await import("bpmn-js/lib/Modeler");

      if (disposed) {
        return null;
      }

      instance = new BpmnModeler({ container });
      modelerRef.current = instance;
      setModelerReady(true);

      instance.on("commandStack.changed", () => {
        setCanvasEdited(true);
      });

      return instance;
    })();

    const observer = new ResizeObserver(() => {
      modelerRef.current?.get<Canvas>("canvas", true).resized();
    });
    observer.observe(container);

    return () => {
      disposed = true;
      observer.disconnect();
      modelerPromiseRef.current = null;
      modelerRef.current = null;
      setModelerReady(false);
      instance?.destroy();
    };
  }, []);

  useEffect(
    () => () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (!isFullscreen) {
      return;
    }

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsFullscreen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isFullscreen]);

  useEffect(() => {
    if (!modelerReady) {
      return;
    }

    modelerRef.current?.get<Canvas>("canvas", true).resized();
  }, [isFullscreen, modelerReady]);

  const handleGenerate = useCallback(async () => {
    setStatus("busy");
    setError(null);
    setLintIssues([]);

    try {
      if (!jsonInput.trim()) {
        throw new Error(
          "Please paste a process definition (JSON) into the editor first.",
        );
      }

      const input = parseDiagramInput(JSON.parse(extractJsonPayload(jsonInput)) as unknown);
      setLintIssues(lintDiagramInput(input));
      const rawXml = await buildBpmnXml(input);
      const laidOutXml = await layoutBpmnXml(rawXml);

      const pendingModeler = modelerPromiseRef.current;
      const modeler = pendingModeler ? await pendingModeler : null;

      if (!modeler) {
        throw new Error(
          "The BPMN modeler is still starting up. Please try again in a moment.",
        );
      }

      const { warnings: importWarnings } = await modeler.importXML(laidOutXml);
      modeler.get<Canvas>("canvas", true).zoom("fit-viewport");

      setCanvasEdited(false);
      setWarnings(importWarnings.map((warning) => String(warning)));
      setSummary({
        fileName: `${input.processId}.bpmn`,
        origin: "generated",
        nodes: input.nodes.length,
        edges: input.edges.length,
        lanes: input.lanes.length,
      });
      setStatus("ready");
    } catch (thrown) {
      setError(describeError(thrown));
      setStatus("error");
    }
  }, [jsonInput]);

  const handleCopyPrompt = useCallback(async () => {
    try {
      await copyToClipboard(buildSystemPrompt(outputLanguage));
      setPromptCopied(true);

      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = window.setTimeout(() => {
        setPromptCopied(false);
        copyTimerRef.current = null;
      }, 2000);
    } catch (thrown) {
      setError(describeError(thrown));
    }
  }, [outputLanguage]);

  const handleImportFile = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const input = event.target;
      const file = input.files?.[0];
      input.value = "";

      if (!file) {
        return;
      }

      setStatus("busy");
      setError(null);
      setLintIssues([]);

      try {
        const rawXml = await file.text();

        if (!rawXml.trimStart().startsWith("<")) {
          throw new Error(
            "The selected file does not contain XML. Please choose a .bpmn or .xml file.",
          );
        }

        const pendingModeler = modelerPromiseRef.current;
        const modeler = pendingModeler ? await pendingModeler : null;

        if (!modeler) {
          throw new Error(
            "The BPMN modeler is still starting up. Please try again in a moment.",
          );
        }

        const hasLayout = /BPMNDiagram/.test(rawXml);
        const importableXml = hasLayout
          ? rawXml
          : await layoutBpmnXml(rawXml);

        const { warnings: importWarnings } = await modeler.importXML(
          importableXml,
        );
        modeler.get<Canvas>("canvas", true).zoom("fit-viewport");

        setCanvasEdited(false);
        setWarnings(importWarnings.map((warning) => String(warning)));
        setSummary({
          fileName: file.name.toLowerCase().endsWith(".xml")
            ? file.name.replace(/\.xml$/i, ".bpmn")
            : file.name,
          origin: "imported",
          nodes: null,
          edges: null,
          lanes: null,
        });
        setStatus("ready");
      } catch (thrown) {
        setError(describeError(thrown));
        setStatus("error");
      }
    },
    [],
  );

  const handleExport = useCallback(
    async (format: DiagramFormat) => {
      const pendingModeler = modelerPromiseRef.current;
      const modeler = pendingModeler ? await pendingModeler : null;

      if (!modeler) {
        return;
      }

      setIsExporting(true);
      setError(null);

      try {
        const { xml: savedXml } = await modeler.saveXML({ format: true });

        if (!savedXml) {
          throw new Error("There is no diagram to export yet.");
        }

        downloadBpmn(savedXml, summary?.fileName ?? "process.bpmn", format);
      } catch (thrown) {
        setError(describeError(thrown));
      } finally {
        setIsExporting(false);
      }
    },
    [summary],
  );

  const handleExportImage = useCallback(async () => {
      const pendingModeler = modelerPromiseRef.current;
      const modeler = pendingModeler ? await pendingModeler : null;

      if (!modeler) {
        return;
      }

      setIsExporting(true);
      setError(null);

      try {
        const { svg } = await modeler.saveSVG();

        if (!svg) {
          throw new Error("There is no diagram to export yet.");
        }

        const base = (summary?.fileName ?? "process").replace(/\.bpmn$/i, "");

        downloadBlob(await svgToPngBlob(svg, IMAGE_SCALE), `${base}.png`);
      } catch (thrown) {
        setError(describeError(thrown));
      } finally {
        setIsExporting(false);
      }
    },
    [summary],
  );

  const handleLoadSample = useCallback(() => {
    setJsonInput(DEFAULT_JSON);
    setError(null);
  }, []);

  const handleReset = useCallback(() => {
    setJsonInput("");
    setStatus("idle");
    setError(null);
    setWarnings([]);
    setLintIssues([]);
    setSummary(null);
    setCanvasEdited(false);
    (modelerRef.current as ResettableModeler | null)?.clear();
  }, []);

  const handleTextareaKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        void handleGenerate();
      }
    },
    [handleGenerate],
  );

  const isBusy = status === "busy";
  const lintErrorCount = lintIssues.filter(
    (issue) => issue.severity === "error",
  ).length;
  const lintHintCount = lintIssues.length - lintErrorCount;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-4 lg:gap-4 lg:p-6">
      <header className="flex shrink-0 items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">
            BPMN FlowSmith
          </h1>
        </div>
      </header>

      <section className="shrink-0 rounded-lg border border-base-300 bg-base-100">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2">
          <button
            type="button"
            onClick={() => setGuideOpen((open) => !open)}
            aria-expanded={guideOpen}
            aria-controls="flowsmith-guide"
            className="flex items-center gap-2 font-semibold"
          >
            <span
              aria-hidden="true"
              className={`transition-transform ${guideOpen ? "rotate-90" : ""}`}
            >
              &#9656;
            </span>
            How to Use
          </button>
          <div className="flex items-center gap-2">

            <label
                htmlFor="flowsmith-output-language"
                className="whitespace-nowrap label"
              >
                Output language
              </label>
              <select
                id="flowsmith-output-language"
                value={outputLanguage}
                onChange={(event) =>
                  storeOutputLanguage(event.target.value as OutputLanguage)
                }
                className="select"
              >
                <option value="en">English</option>
                <option value="de">Deutsch</option>
              </select>
              <button
                type="button"
                onClick={() => void handleCopyPrompt()}
                className={`btn btn-outline ${
                  promptCopied
                    ? "btn-success"
                    : ""
                }`}
              >
                {promptCopied ? "Copied!" : "Copy Prompt"}
              </button>
          </div>
        </div>

        {guideOpen ? (
          <ol
            id="flowsmith-guide"
            className="grid max-h-40 gap-4 overflow-y-auto border-t border-base-300 px-4 py-3 sm:grid-cols-3"
          >
            {buildGuideSteps(PROMPT_LANGUAGE_RULES[outputLanguage].placeholder).map((step, index) => (
              <li key={step.title} className="flex gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-neutral text-xs font-semibold text-neutral-content">
                  {index + 1}
                </span>
                <span>
                  <span className="block font-medium">
                    {step.title}
                  </span>
                  <span className="mt-1 block text-base-content/70">
                    {step.description}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        ) : null}
      </section>

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        <section className="flex min-h-0 flex-col gap-3 overflow-y-auto">
          <div className="flex shrink-0 items-baseline justify-between gap-2">
            <label
              className="label"
              htmlFor="flowsmith-json"
            >
              Process definition (JSON)
            </label>
          </div>
          <textarea
            id="flowsmith-json"
            spellCheck={false}
            value={jsonInput}
            onChange={(event) => setJsonInput(event.target.value)}
            onKeyDown={handleTextareaKeyDown}
            className="textarea min-h-32 w-full flex-1 resize-none overflow-auto font-mono text-xs leading-relaxed"
          />

          <div className="flex shrink-0 flex-col gap-2">
            <button
              type="button"
              onClick={() => void handleGenerate()}
              disabled={isBusy || !modelerReady}
              className="btn btn-primary"
            >
              {isBusy ? "Generating…" : "Generate & Edit Diagram"}
            </button>

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => void handleExport("bpmn")}
                disabled={!summary || isBusy || isExporting}
                className="btn btn-outline"
              >
                {isExporting ? "Exporting…" : "Export .bpmn"}
              </button>

              <button
                type="button"
                onClick={() => void handleExport("xml")}
                disabled={!summary || isBusy || isExporting}
                className="btn btn-outline"
              >
                Export .xml
              </button>

              <button
                type="button"
                onClick={() => void handleExportImage()}
                disabled={!summary || isBusy || isExporting}
                className="btn btn-outline"
              >
                Export PNG
              </button>

              <label
                className="btn btn-outline"
              >
                Import .bpmn
                <input
                  type="file"
                  accept=".bpmn,.xml,application/xml,text/xml"
                  disabled={isBusy || !modelerReady}
                  onChange={(event) => void handleImportFile(event)}
                  className="sr-only"
                />
              </label>

              <button type="button" onClick={handleLoadSample} className="btn btn-outline">
                Load sample
              </button>

              <button
                type="button"
                onClick={handleReset}
                disabled={isBusy}
                className="btn btn-outline btn-error"
              >
                Reset
              </button>
            </div>
            </div>

          {error ? (
            <div role="alert" className="alert alert-error">
              {error}
            </div>
          ) : null}

          {status === "ready" && summary ? (
            <div className="alert alert-success">
              {summary.origin === "generated" ? (
                <>
                  Rendered {summary.nodes} nodes, {summary.edges} flows
                  {summary.lanes ? ` across ${summary.lanes} lanes` : ""}.
                  Export it as{" "}
                  <span className="font-mono">{summary.fileName}</span>.
                </>
              ) : (
                <>
                  Imported{" "}
                  <span className="font-mono">{summary.fileName}</span>. Edit it
                  on the canvas — your changes are included when you export.
                </>
              )}
            </div>
          ) : null}

          {warnings.length > 0 ? (
            <details className="rounded-box border border-base-300 bg-base-200 p-3 text-sm">
              <summary className="cursor-pointer font-medium">
                {warnings.length} import warning
                {warnings.length === 1 ? "" : "s"}
              </summary>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-xs">
                {warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </details>
          ) : null}

          {lintIssues.length > 0 ? (
            <details className="rounded-box border border-base-300 bg-base-200 p-3 text-sm">
              <summary className="cursor-pointer font-medium">
                Model check: {lintErrorCount} error
                {lintErrorCount === 1 ? "" : "s"},{" "}
                {lintHintCount} hint{lintHintCount === 1 ? "" : "s"}
              </summary>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-xs">
                {lintIssues.map((issue) => (
                  <li
                    key={`${issue.path}:${issue.message}`}
                    className={
                      issue.severity === "error"
                        ? "font-medium text-error"
                        : undefined
                    }
                  >
                    <span className="font-mono">{issue.path}</span>: {issue.message}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </section>

        <section
          className={
            isFullscreen
              ? "fixed inset-0 z-50 flex flex-col bg-base-100"
              : "flex min-h-0 flex-col rounded-lg border border-base-300 bg-base-100"
          }
        >
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-base-200 px-4 py-2 font-medium tracking-wide text-base-content/60 uppercase">
            <span className="flex items-center gap-2">
              <span>Diagram · editable</span>
              {canvasEdited ? (
                <span className="badge badge-warning badge-sm normal-case">
                  edited
                </span>
              ) : null}
            </span>
            <span className="flex items-center gap-3 normal-case">
              <span>{modelerReady ? "Ready" : "Loading modeler…"}</span>
              <button
                type="button"
                onClick={() => setIsFullscreen((active) => !active)}
                aria-pressed={isFullscreen}
                className="btn btn-outline"
              >
                {isFullscreen ? "Exit fullscreen (Esc)" : "Fullscreen"}
              </button>
            </span>
          </div>
          <div className="relative min-h-0 flex-1">
            <div ref={containerRef} className="h-full w-full" />
            {!summary ? (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center text-base-content/40">
                Generate a diagram from JSON or import an existing .bpmn file
                to start editing
              </div>
            ) : null}
          </div>
          {summary ? (
            <p className="shrink-0 border-t border-base-200 px-4 py-2 text-xs text-base-content/60">
              Drag elements, double-click to rename, or use the palette and
              context pad to extend the process.
            </p>
          ) : null}
        </section>
      </div>
    </div>
  );
}
