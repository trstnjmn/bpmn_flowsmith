"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent } from "react";
import type Canvas from "diagram-js/lib/core/Canvas";
import {
  SUPPORTED_NODE_TYPES,
  DiagramInputError,
  buildBpmnXml,
  layoutBpmnXml,
  parseDiagramInput,
} from "@/lib/bpmn-diagram";
import "bpmn-js/dist/assets/diagram-js.css";
import "bpmn-js/dist/assets/bpmn-js.css";
import "bpmn-js/dist/assets/bpmn-font/css/bpmn.css";
import { btnGhost, btnPrimary, btnSecondary } from "./theme";

type BpmnModelerInstance = InstanceType<
  (typeof import("bpmn-js/lib/Modeler"))["default"]
>;

type ResettableModeler = BpmnModelerInstance & { clear(): void };

type Status = "idle" | "busy" | "ready" | "error";

type RenderSummary = {
  fileName: string;
  origin: "generated" | "imported";
  nodes: number | null;
  edges: number | null;
  lanes: number | null;
};

const QWENCODER_SYSTEM_PROMPT = `You are a high-precision systems architect specializing in Business Process Model and Notation (BPMN 2.0).
Your task is to translate free-text business process descriptions into a strict, valid JSON structure. This structure will later be automatically converted into BPMN XML.

### CRITICAL RULES:
1. Output ONLY a single, valid JSON object. Do NOT include any markdown code blocks (no \`\`\`json), no introductory text, and no explanations.
2. ALL human-readable strings (processName, lane names, node labels, edge conditions) MUST BE IN GERMAN.
3. Identify all actors or roles (Lanes) and create an entry for each in the "lanes" array.
4. Use ONLY these exact BPMN types for "nodes":
   - "startEvent" (exactly one per process)
   - "endEvent"
   - "userTask" (manual / human action)
   - "serviceTask" (automated system / script action)
   - "exclusiveGateway" (XOR decision point)
   - "parallelGateway" (parallel split or join)
5. Every node MUST have a unique "id", a concise German "label" (Verb + Noun, e.g. "Antrag prüfen"), and a valid "laneId" matching a lane from the "lanes" array.
6. In the "edges" array, every entry MUST have a unique "id", "sourceId", and "targetId".
   - For outgoing edges from gateways, you MUST include a German "condition" attribute (e.g. "Ja", "Nein", "Gültig").

### REQUIRED JSON SCHEMA:
{
  "processId": "Process_1",
  "processName": "Antragsprüfung",
  "lanes": [
    { "id": "lane_1", "name": "Sachbearbeiter" },
    { "id": "lane_2", "name": "System" }
  ],
  "nodes": [
    { "id": "start_1", "type": "startEvent", "label": "Antrag eingegangen", "laneId": "lane_1" },
    { "id": "task_1", "type": "userTask", "label": "Antrag prüfen", "laneId": "lane_1" },
    { "id": "gw_1", "type": "exclusiveGateway", "label": "Gültig?", "laneId": "lane_1" },
    { "id": "task_2", "type": "serviceTask", "label": "Bestätigung senden", "laneId": "lane_2" },
    { "id": "end_1", "type": "endEvent", "label": "Prozess abgeschlossen", "laneId": "lane_1" }
  ],
  "edges": [
    { "id": "e1", "sourceId": "start_1", "targetId": "task_1" },
    { "id": "e2", "sourceId": "task_1", "targetId": "gw_1" },
    { "id": "e3", "sourceId": "gw_1", "targetId": "task_2", "condition": "Ja" },
    { "id": "e4", "sourceId": "gw_1", "targetId": "end_1", "condition": "Nein" },
    { "id": "e5", "sourceId": "task_2", "targetId": "end_1" }
  ]
}

### INPUT PROCESS DESCRIPTION:
[Hier die deutsche Prozessbeschreibung einfügen]`;

const GUIDE_STEPS = [
  {
    title: "Copy the QwenCoder system prompt",
    description:
      "Use the button below to put the strict BPMN JSON prompt on your clipboard.",
  },
  {
    title: "Paste it into your OpenCode LLM",
    description:
      "Combine the prompt with a plain-English description of your process and let the LLM return the JSON structure.",
  },
  {
    title: "Paste the JSON and generate",
    description:
      'Paste the JSON into the editor and click "Generate & Edit Diagram".',
  },
] as const;

function downloadBpmn(xml: string, fileName: string): void {
  const blob = new Blob([xml], {
    type: "application/bpmn20-xml;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
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
  processId: "Process_1",
  processName: "Application Review",
  lanes: [
    { id: "lane_1", name: "Clerk" },
    { id: "lane_2", name: "System" },
  ],
  nodes: [
    {
      id: "start_1",
      type: "startEvent",
      label: "Application Received",
      laneId: "lane_1",
    },
    {
      id: "task_1",
      type: "userTask",
      label: "Review Application",
      laneId: "lane_1",
    },
    {
      id: "gw_1",
      type: "exclusiveGateway",
      label: "Is Valid?",
      laneId: "lane_1",
    },
    {
      id: "task_2",
      type: "serviceTask",
      label: "Send Confirmation",
      laneId: "lane_2",
    },
    {
      id: "end_1",
      type: "endEvent",
      label: "Process Completed",
      laneId: "lane_1",
    },
  ],
  edges: [
    { id: "e1", sourceId: "start_1", targetId: "task_1" },
    { id: "e2", sourceId: "task_1", targetId: "gw_1" },
    { id: "e3", sourceId: "gw_1", targetId: "task_2", condition: "Yes" },
    { id: "e4", sourceId: "gw_1", targetId: "end_1", condition: "No" },
    { id: "e5", sourceId: "task_2", targetId: "end_1" },
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
  const [xml, setXml] = useState<string | null>(null);
  const [summary, setSummary] = useState<RenderSummary | null>(null);
  const [modelerReady, setModelerReady] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [canvasEdited, setCanvasEdited] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [promptCopied, setPromptCopied] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

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

    try {
      if (!jsonInput.trim()) {
        throw new Error(
          "Please paste a process definition (JSON) into the editor first.",
        );
      }

      const input = parseDiagramInput(JSON.parse(jsonInput) as unknown);
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

      setXml(laidOutXml);
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
      await copyToClipboard(QWENCODER_SYSTEM_PROMPT);
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
  }, []);

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

        setXml(importableXml);
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

  const handleExport = useCallback(async () => {
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

      setXml(savedXml);
      downloadBpmn(savedXml, summary?.fileName ?? "process.bpmn");
    } catch (thrown) {
      setError(describeError(thrown));
    } finally {
      setIsExporting(false);
    }
  }, [summary]);

  const handleLoadSample = useCallback(() => {
    setJsonInput(DEFAULT_JSON);
    setError(null);
  }, []);

  const handleReset = useCallback(() => {
    setJsonInput("");
    setStatus("idle");
    setError(null);
    setWarnings([]);
    setXml(null);
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

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-4 lg:gap-4 lg:p-6">
      <header className="flex shrink-0 items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            BPMN FlowSmith
          </h1>
        </div>
      </header>

      <section className="shrink-0 rounded-xl border border-zinc-300 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2">
          <button
            type="button"
            onClick={() => setGuideOpen((open) => !open)}
            aria-expanded={guideOpen}
            aria-controls="flowsmith-guide"
            className="flex items-center gap-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100"
          >
            <span
              aria-hidden="true"
              className={`transition-transform ${guideOpen ? "rotate-90" : ""}`}
            >
              &#9656;
            </span>
            How to Use
          </button>
          <button
            type="button"
            onClick={() => void handleCopyPrompt()}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
              promptCopied
                ? "bg-emerald-600 text-white"
                : "border border-zinc-300 text-zinc-800 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
            }`}
          >
            {promptCopied ? "Copied!" : "Copy QwenCoder Prompt"}
          </button>
        </div>

        {guideOpen ? (
          <ol
            id="flowsmith-guide"
            className="grid max-h-40 gap-4 overflow-y-auto border-t border-zinc-200 px-4 py-3 text-sm sm:grid-cols-3 dark:border-zinc-800"
          >
            {GUIDE_STEPS.map((step, index) => (
              <li key={step.title} className="flex gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-xs font-semibold text-white dark:bg-zinc-100 dark:text-zinc-900">
                  {index + 1}
                </span>
                <span>
                  <span className="block font-medium text-zinc-900 dark:text-zinc-100">
                    {step.title}
                  </span>
                  <span className="mt-1 block text-zinc-600 dark:text-zinc-400">
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
              className="text-sm font-medium text-zinc-800 dark:text-zinc-200"
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
            className="min-h-32 w-full flex-1 resize-none overflow-auto rounded-lg border border-zinc-300 bg-white p-3 font-mono text-xs leading-relaxed text-zinc-800 outline-none focus:border-zinc-500 focus:ring-2 focus:ring-zinc-900/10 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
          />

          <div className="flex shrink-0 flex-col gap-2">
            <button
              type="button"
              onClick={() => void handleGenerate()}
              disabled={isBusy || !modelerReady}
              className={btnPrimary}
            >
              {isBusy ? "Generating…" : "Generate & Edit Diagram"}
            </button>

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => void handleExport()}
                disabled={!summary || isBusy || isExporting}
                className={btnSecondary}
              >
                {isExporting ? "Exporting…" : "Export .bpmn"}
              </button>

              <label
                className={`${btnSecondary} cursor-pointer focus-within:ring-2 focus-within:ring-zinc-900/30 dark:focus-within:ring-zinc-100/30 ${
                  isBusy || !modelerReady ? "pointer-events-none opacity-50" : ""
                }`}
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
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button type="button" onClick={handleLoadSample} className={btnGhost}>
                Load sample
              </button>
              <button
                type="button"
                onClick={handleReset}
                disabled={isBusy}
                className={btnGhost}
              >
                Reset
              </button>
            </div>
          </div>

          {error ? (
            <div
              role="alert"
              className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
            >
              {error}
            </div>
          ) : null}

          {status === "ready" && summary ? (
            <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
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
            <details className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
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

          <details className="rounded-lg border border-zinc-300 p-3 text-sm text-zinc-700 dark:border-zinc-700 dark:text-zinc-300">
            <summary className="cursor-pointer font-medium">
              Supported node types
            </summary>
            <p className="mt-2 font-mono text-xs leading-relaxed wrap-break-word">
              {SUPPORTED_NODE_TYPES.join(", ")}
            </p>
          </details>

          {xml ? (
            <details className="rounded-lg border border-zinc-300 p-3 text-sm text-zinc-700 dark:border-zinc-700 dark:text-zinc-300">
              <summary className="cursor-pointer font-medium">
                BPMN 2.0 XML
                {canvasEdited ? " (canvas edits are not shown here yet)" : ""}
              </summary>
              <pre className="mt-2 max-h-64 overflow-auto rounded bg-zinc-100 p-2 font-mono text-xs whitespace-pre dark:bg-zinc-900">
                {xml}
              </pre>
            </details>
          ) : null}
        </section>

        <section
          className={
            isFullscreen
              ? "fixed inset-0 z-50 flex flex-col bg-white dark:bg-zinc-950"
              : "flex min-h-0 flex-col rounded-xl border border-zinc-300 bg-white dark:border-zinc-800 dark:bg-zinc-950"
          }
        >
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-zinc-200 px-4 py-2 text-xs font-medium tracking-wide text-zinc-500 uppercase dark:border-zinc-800 dark:text-zinc-400">
            <span className="flex items-center gap-2">
              <span>Diagram · editable</span>
              {canvasEdited ? (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-amber-800 normal-case dark:bg-amber-950/60 dark:text-amber-200">
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
                className="rounded-md border border-zinc-300 px-2 py-1 font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
              >
                {isFullscreen ? "Exit fullscreen (Esc)" : "Fullscreen"}
              </button>
            </span>
          </div>
          <div className="relative min-h-0 flex-1">
            <div ref={containerRef} className="h-full w-full" />
            {!summary ? (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-zinc-400">
                Generate a diagram from JSON or import an existing .bpmn file
                to start editing
              </div>
            ) : null}
          </div>
          {summary ? (
            <p className="shrink-0 border-t border-zinc-200 px-4 py-2 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
              Drag elements, double-click to rename, or use the palette and
              context pad to extend the process.
            </p>
          ) : null}
        </section>
      </div>
    </div>
  );
}
