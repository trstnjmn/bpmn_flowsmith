const assert = require("node:assert/strict");
const test = require("node:test");

const { load } = require("./helpers/loader.js");

const lintDiagramInput = load("lib/bpmn-lint.ts", "lintDiagramInput");
const parseDiagramInput = load("lib/bpmn-diagram.ts", "parseDiagramInput");

const lint = (raw) => lintDiagramInput(parseDiagramInput(raw));
const severities = (issues) => issues.map((issue) => issue.severity);
const texts = (issues) => issues.map((issue) => issue.message).join("\n");

const clean = {
  processId: "P_Check",
  processName: "Prüfung",
  lanes: [{ id: "l1", name: "Sachbearbeiter" }],
  nodes: [
    { id: "s1", type: "startEvent", label: "Antrag da", laneId: "l1" },
    { id: "t1", type: "userTask", label: "Antrag prüfen", laneId: "l1" },
    { id: "e1", type: "endEvent", label: "Fertig", laneId: "l1" },
    { id: "d1", type: "dataStoreReference", label: "Kundenstamm" },
  ],
  edges: [
    { id: "e_1", sourceId: "s1", targetId: "t1" },
    { id: "e_2", sourceId: "t1", targetId: "e1" },
  ],
  dataAssociations: [
    { id: "da1", nodeId: "t1", dataNodeId: "d1", direction: "read" },
  ],
};

test("a well-formed model produces no issues", () => {
  assert.deepEqual(lint(clean), []);
});

test("missing start event is an error", () => {
  const issues = lint({
    ...clean,
    nodes: clean.nodes.filter((node) => node.id !== "s1"),
    edges: [{ id: "e_1", sourceId: "t1", targetId: "e1" }],
  });

  assert.deepEqual(severities(issues), ["error"]);
  assert.match(issues[0].path, /^process$/);
  assert.match(issues[0].message, /No start event/);
});

test("a node nothing reaches is an error", () => {
  const issues = lint({
    ...clean,
    nodes: [...clean.nodes, { id: "t2", type: "userTask", label: "Verwaist", laneId: "l1" }],
  });

  assert.deepEqual(severities(issues), ["error"]);
  assert.match(issues[0].message, /never reached from a start event/);
});

test("an edge leaving an end event is an error", () => {
  const issues = lint({
    ...clean,
    nodes: [
      ...clean.nodes,
      { id: "t2", type: "userTask", label: "Nach dem Ende", laneId: "l1" },
    ],
    edges: [...clean.edges, { id: "e_3", sourceId: "e1", targetId: "t2" }],
  });

  assert.deepEqual(severities(issues), ["error"]);
  assert.match(issues[0].path, /^edges\[\d+\]$/);
  assert.match(issues[0].message, /leaves the end event/);
});

test("a data element without an association is an error", () => {
  const issues = lint({ ...clean, dataAssociations: [] });

  assert.deepEqual(severities(issues), ["error"]);
  assert.match(issues[0].message, /not associated with any step/);
});

test("a node without a label is an error", () => {
  const issues = lint({
    ...clean,
    nodes: clean.nodes.map((node) =>
      node.id === "t1" ? { ...node, label: undefined } : node,
    ),
  });

  assert.deepEqual(severities(issues), ["error"]);
  assert.match(issues[0].message, /has no label/);
});

test("a gateway without branches is a hint", () => {
  const issues = lint({
    ...clean,
    nodes: [
      ...clean.nodes,
      { id: "g1", type: "exclusiveGateway", label: "Freigabe?", laneId: "l1" },
    ],
    edges: [
      ...clean.edges,
      { id: "e_3", sourceId: "g1", targetId: "e1", condition: "Ja" },
      { id: "e_4", sourceId: "s1", targetId: "g1" },
    ],
  });

  assert.deepEqual(severities(issues), ["hint"]);
  assert.match(issues[0].message, /only one outgoing flow/);
});

test("a decision branch without a condition is a hint", () => {
  const issues = lint({
    ...clean,
    nodes: [
      ...clean.nodes,
      { id: "g1", type: "exclusiveGateway", label: "Freigabe?", laneId: "l1" },
    ],
    edges: [
      { id: "e_1", sourceId: "s1", targetId: "g1" },
      { id: "e_2", sourceId: "g1", targetId: "t1" },
      { id: "e_3", sourceId: "g1", targetId: "e1", condition: "Nein" },
      { id: "e_4", sourceId: "t1", targetId: "e1" },
    ],
  });

  assert.deepEqual(severities(issues), ["hint"]);
  assert.match(issues[0].message, /has no condition/);
});

test("an empty lane is a hint", () => {
  const issues = lint({
    ...clean,
    lanes: [...clean.lanes, { id: "l2", name: "Leitung" }],
  });

  assert.deepEqual(severities(issues), ["hint"]);
  assert.match(issues[0].message, /contains no node/);
});

test("a flow node outside every lane is a hint", () => {
  const issues = lint({
    ...clean,
    nodes: clean.nodes.map((node) =>
      node.id === "t1" ? { ...node, laneId: undefined } : node,
    ),
  });

  assert.deepEqual(severities(issues), ["hint"]);
  assert.match(issues[0].message, /not assigned to a lane/);
});

test("a label describing two steps points at section 3d", () => {
  const issues = lint({
    ...clean,
    nodes: clean.nodes.map((node) =>
      node.id === "t1" ? { ...node, label: "Prüfen und freigeben" } : node,
    ),
  });

  assert.deepEqual(severities(issues), ["hint"]);
  assert.match(issues[0].message, /section 3d/);
});

test("duplicate labels are a hint", () => {
  const issues = lint({
    ...clean,
    nodes: [
      ...clean.nodes.slice(0, 3),
      { id: "t2", type: "userTask", label: "Antrag prüfen", laneId: "l1" },
      clean.nodes[3],
    ],
    edges: [
      ...clean.edges,
      { id: "e_3", sourceId: "s1", targetId: "t2" },
      { id: "e_4", sourceId: "t2", targetId: "e1" },
    ],
  });

  assert.deepEqual(severities(issues), ["hint"]);
  assert.match(issues[0].message, /share the label/);
});

test("errors are listed before hints", () => {
  const issues = lint({
    ...clean,
    lanes: [...clean.lanes, { id: "l2", name: "Leitung" }],
    nodes: clean.nodes.map((node) =>
      node.id === "s1" ? { ...node, label: undefined } : node,
    ),
  });

  assert.ok(issues.length >= 2, texts(issues));
  assert.deepEqual([...severities(issues)].sort(), issues.map((issue) => issue.severity));
  assert.equal(issues[0].severity, "error");
  assert.ok(issues.some((issue) => issue.severity === "hint"));
});

test("hints alone never fail the model", () => {
  const issues = lint({
    ...clean,
    lanes: [...clean.lanes, { id: "l2", name: "Leitung" }],
    nodes: [
      ...clean.nodes,
      { id: "g1", type: "exclusiveGateway", label: "Freigabe?", laneId: "l1" },
    ],
    edges: [
      ...clean.edges,
      { id: "e_3", sourceId: "g1", targetId: "e1" },
      { id: "e_4", sourceId: "s1", targetId: "g1" },
    ],
  });

  assert.ok(issues.length > 0, "expected hints");
  assert.equal(issues.filter((issue) => issue.severity === "error").length, 0, texts(issues));
});
