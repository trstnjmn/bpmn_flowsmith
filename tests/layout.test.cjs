const assert = require("node:assert/strict");
const test = require("node:test");

const { PROJECT_ROOT: p, load } = require("./helpers/loader.js");

const diagramToLaidOutXml = load("lib/bpmn-diagram.ts", "diagramToLaidOutXml");
const layoutBpmnXml = load("lib/bpmn-diagram.ts", "layoutBpmnXml");
const parseDiagramInput = load("lib/bpmn-diagram.ts", "parseDiagramInput");
const { BpmnModdle } = require(require.resolve("bpmn-moddle", { paths: [p] }));

// Two separate tolerances:
//  - ALIGN decides whether two segments lie on the same line at all.
//  - OVERLAP is the length a shared run may have before it counts as a defect.
//    It matches EDGE_OVERLAP_TOLERANCE in lib/bpmn-diagram.ts.
const ALIGN = 2;
const OVERLAP = 4;
const failures = [];

function check(label, condition, detail) {
  if (condition) return;
  failures.push(detail ? `${label} -> ${detail}` : label);
}

function overlapLen(a, b) {
  const h1 = a[0].y === a[1].y;
  const h2 = b[0].y === b[1].y;
  if (h1 && h2 && Math.abs(a[0].y - b[0].y) <= ALIGN) {
    const p = Math.min(a[0].x, a[1].x), q = Math.max(a[0].x, a[1].x);
    const r = Math.min(b[0].x, b[1].x), s = Math.max(b[0].x, b[1].x);
    return Math.max(0, Math.min(q, s) - Math.max(p, r));
  }
  if (!h1 && !h2 && Math.abs(a[0].x - b[0].x) <= ALIGN) {
    const p = Math.min(a[0].y, a[1].y), q = Math.max(a[0].y, a[1].y);
    const r = Math.min(b[0].y, b[1].y), s = Math.max(b[0].y, b[1].y);
    return Math.max(0, Math.min(q, s) - Math.max(p, r));
  }
  return 0;
}

async function analyse(xml) {
  const { rootElement, warnings } = await new BpmnModdle().fromXML(xml);
  const diagrams = rootElement.get("diagrams") || [];
  const plane = diagrams[0] ? diagrams[0].get("plane") : null;
  const els = plane ? plane.get("planeElement") || [] : [];
  const shapes = els.filter((e) => e.$type === "bpmndi:BPMNShape");
  const edges = els.filter((e) => e.$type === "bpmndi:BPMNEdge");
  const laneShapes = shapes.filter(
    (e) => String(e.get("bpmnElement").$type) === "bpmn:Lane",
  );

  let overlapPairs = 0;
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const sa = edges[i].get("waypoint") || [];
      const sb = edges[j].get("waypoint") || [];
      let worst = 0;
      for (let x = 0; x + 1 < sa.length; x++) {
        for (let y = 0; y + 1 < sb.length; y++) {
          worst = Math.max(worst, overlapLen([sa[x], sa[x + 1]], [sb[y], sb[y + 1]]));
        }
      }
      if (worst > OVERLAP) overlapPairs++;
    }
  }

  let diagonal = 0;
  let zeroLength = 0;
  for (const e of edges) {
    const wps = e.get("waypoint") || [];
    if (wps.length < 2) zeroLength++;
    for (let i = 0; i + 1 < wps.length; i++) {
      const sameX = wps[i].x === wps[i + 1].x;
      const sameY = wps[i].y === wps[i + 1].y;
      if (sameX && sameY) zeroLength++;
      else if (!sameX && !sameY) diagonal++;
    }
  }

  let outsideLane = 0;
  for (const s of shapes) {
    const bo = s.get("bpmnElement");
    if (String(bo.$type) === "bpmn:Lane") continue;
    const owner = String(bo.id);
    const lane = laneShapes.find((ls) =>
      (ls.get("bpmnElement").get("flowNodeRef") || []).map((r) => String(r.id)).includes(owner),
    );
    if (!lane) continue;
    const b = s.get("bounds");
    const lr = lane.get("bounds");
    if (b.x < lr.x + 30 || b.y < lr.y || b.x + b.width > lr.x + lr.width || b.y + b.height > lr.y + lr.height) {
      outsideLane++;
    }
  }

  return { warnings: warnings.length, shapes, edges, overlapPairs, diagonal, zeroLength, outsideLane, laneShapes };
}

const laneSamples = {
  "3 roles": {
    processId: "Proc_A", processName: "Antragsprüfung",
    lanes: [{ id: "l1", name: "Sachbearbeiter" }, { id: "l2", name: "Fachbereichsleitung" }, { id: "l3", name: "Bestellsystem" }],
    nodes: [
      { id: "s1", type: "startEvent", label: "Antrag eingegangen", laneId: "l1" },
      { id: "t1", type: "userTask", label: "Antrag prüfen", laneId: "l1" },
      { id: "g1", type: "exclusiveGateway", label: "Antrag gültig?", laneId: "l1" },
      { id: "t2", type: "userTask", label: "Freigabe erteilen", laneId: "l2" },
      { id: "t3", type: "serviceTask", label: "Bestellung anlegen", laneId: "l3" },
      { id: "x1", type: "endEvent", label: "Prozess abgeschlossen", laneId: "l1" },
    ],
    edges: [
      { id: "e1", sourceId: "s1", targetId: "t1" }, { id: "e2", sourceId: "t1", targetId: "g1" },
      { id: "e3", sourceId: "g1", targetId: "t2", condition: "Ja" },
      { id: "e4", sourceId: "g1", targetId: "x1", condition: "Nein" },
      { id: "e5", sourceId: "t2", targetId: "t3" }, { id: "e6", sourceId: "t3", targetId: "x1" },
    ],
  },
  "5x parallel fan-out": {
    processId: "Proc_B",
    lanes: [{ id: "l1", name: "Sachbearbeiter" }, { id: "l2", name: "System" }],
    nodes: [
      { id: "s1", type: "startEvent", label: "Start", laneId: "l1" },
      { id: "g1", type: "parallelGateway", label: "Split", laneId: "l1" },
      ...[0, 1, 2, 3, 4].map((i) => ({ id: "t" + i, type: "userTask", label: "Schritt " + i, laneId: i % 2 ? "l2" : "l1" })),
      { id: "j1", type: "exclusiveGateway", label: "Join", laneId: "l1" },
      { id: "x1", type: "endEvent", label: "Ende", laneId: "l1" },
    ],
    edges: [
      { id: "f0", sourceId: "s1", targetId: "g1" },
      ...[0, 1, 2, 3, 4].map((i) => ({ id: "fa" + i, sourceId: "g1", targetId: "t" + i })),
      ...[0, 1, 2, 3, 4].map((i) => ({ id: "fb" + i, sourceId: "t" + i, targetId: "j1" })),
      { id: "fz", sourceId: "j1", targetId: "x1" },
    ],
  },
  "8x fan-out": {
    processId: "Proc_C",
    lanes: [{ id: "l1", name: "A" }, { id: "l2", name: "B" }, { id: "l3", name: "C" }],
    nodes: [
      { id: "g1", type: "parallelGateway", label: "Split", laneId: "l1" },
      ...Array.from({ length: 8 }, (_, i) => ({ id: "t" + i, type: "userTask", label: "T" + i, laneId: ["l1", "l2", "l3"][i % 3] })),
      { id: "j1", type: "exclusiveGateway", label: "Join", laneId: "l1" },
    ],
    edges: [
      ...Array.from({ length: 8 }, (_, i) => ({ id: "fa" + i, sourceId: "g1", targetId: "t" + i })),
      ...Array.from({ length: 8 }, (_, i) => ({ id: "fb" + i, sourceId: "t" + i, targetId: "j1" })),
    ],
  },
  "self loop + backward": {
    processId: "Proc_D",
    lanes: [{ id: "l1", name: "Sachbearbeiter" }, { id: "l2", name: "Leitung" }],
    nodes: [
      { id: "t1", type: "userTask", label: "Korrigieren", laneId: "l1" },
      { id: "t2", type: "userTask", label: "Prüfen", laneId: "l1" },
      { id: "t3", type: "userTask", label: "Freigabe", laneId: "l2" },
    ],
    edges: [
      { id: "e1", sourceId: "t1", targetId: "t1" },
      { id: "e2", sourceId: "t1", targetId: "t2" },
      { id: "e3", sourceId: "t2", targetId: "t1" },
      { id: "e4", sourceId: "t2", targetId: "t3" },
    ],
  },
};

test("layout, routing and data association regression", async () => {
  for (const [name, input] of Object.entries(laneSamples)) {
    const xml = await diagramToLaidOutXml(input);
    const r = await analyse(xml);
    check(
      name + ": no warnings",
      r.warnings === 0,
      "warnings=" + r.warnings,
    );
    check(name + ": no overlapping edge pairs", r.overlapPairs === 0, "pairs=" + r.overlapPairs);
    check(name + ": all segments orthogonal", r.diagonal === 0, "diagonal=" + r.diagonal);
    check(name + ": no zero-length segments", r.zeroLength === 0, "zeroLength=" + r.zeroLength);
    check(name + ": no node outside its lane", r.outsideLane === 0, "outside=" + r.outsideLane);
    check(
      name + ": every edge has waypoints",
      r.edges.every((e) => (e.get("waypoint") || []).length >= 2),
    );
    check(name + ": no junk waypoints attribute", !xml.includes('waypoints="'));
  }

  const single = await analyse(await diagramToLaidOutXml({
    processId: "Proc_H", lanes: [{ id: "l1", name: "Solo" }],
    nodes: [{ id: "t1", type: "userTask", label: "Allein", laneId: "l1" }], edges: [],
  }));
  const h = single.laneShapes[0].get("bounds").height;
  check("single-node lane is at least 140 high", h >= 140, "height=" + h);

  const reject = [
    ["laneId on dataStoreReference", { processId: "P", lanes: [{ id: "l1", name: "A" }], nodes: [{ id: "t1", type: "userTask", label: "A", laneId: "l1" }, { id: "d1", type: "dataStoreReference", label: "DB", laneId: "l1" }], edges: [] }],
    ["edge to dataStoreReference", { processId: "P", lanes: [{ id: "l1", name: "A" }], nodes: [{ id: "t1", type: "userTask", label: "A", laneId: "l1" }, { id: "d1", type: "dataStoreReference", label: "DB" }], edges: [{ id: "e1", sourceId: "t1", targetId: "d1" }] }],
    ["edge from dataObjectReference", { processId: "P", lanes: [], nodes: [{ id: "t1", type: "userTask", label: "A" }, { id: "d1", type: "dataObjectReference", label: "Obj" }], edges: [{ id: "e1", sourceId: "d1", targetId: "t1" }] }],
    ["id starting with a digit", { processId: "P", lanes: [{ id: "l1", name: "A" }], nodes: [{ id: "1abc", type: "userTask", label: "A", laneId: "l1" }], edges: [] }],
  ];
  for (const [name, input] of reject) {
    let msg = "";
    try { parseDiagramInput(input); } catch (e) { msg = e.message; }
    check("rejects " + name, msg.length > 0, "no error raised");
  }
  let standaloneOk = true;
  try {
    parseDiagramInput({
      processId: "P", lanes: [{ id: "l1", name: "A" }],
      nodes: [{ id: "t1", type: "userTask", label: "A", laneId: "l1" }, { id: "d1", type: "dataStoreReference", label: "DB" }],
      edges: [],
    });
  } catch { standaloneOk = false; }
  check("accepts a standalone data store outside the lanes", standaloneOk);

  const noDi = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Defs_1" targetNamespace="http://bpmn.io/schema/bpmn">',
    '<bpmn:process id="Proc_1" isExecutable="false">',
    '<bpmn:startEvent id="Start_1" />',
    '<bpmn:userTask id="Task_1" name="Prüfen" />',
    '<bpmn:endEvent id="End_1" />',
    '<bpmn:sequenceFlow id="Flow_1" sourceRef="Start_1" targetRef="Task_1" />',
    '<bpmn:sequenceFlow id="Flow_2" sourceRef="Task_1" targetRef="End_1" />',
    "</bpmn:process></bpmn:definitions>",
  ].join("");
  const laid = await layoutBpmnXml(noDi);
  const r2 = await analyse(laid);
  check("external file without DI gets edges", r2.edges.length === 2, "edges=" + r2.edges.length);
  check("external file without DI gets shapes", r2.shapes.length === 3, "shapes=" + r2.shapes.length);
  check("no unknown-attribute warnings", r2.warnings === 0, "warnings=" + r2.warnings);

  const withData = noDi.replace(
    "<bpmn:sequenceFlow id=\"Flow_1\"",
    "<bpmn:dataStoreReference id=\"Store_1\" name=\"DB\" />\n    <bpmn:sequenceFlow id=\"Flow_1\"",
  );
  const laidData = await layoutBpmnXml(withData);
  const r3 = await analyse(laidData);
  check("data store survives the layout", r3.shapes.some((s) => String(s.get("bpmnElement").$type) === "bpmn:DataStoreReference"));
  check("no warnings with data elements", r3.warnings === 0, "warnings=" + r3.warnings);
  check("no incoming= attribute on data store", !/dataStoreReference[^>]*incoming=/.test(laidData));
  check("edges still routed", r3.edges.length === 2, "edges=" + r3.edges.length);

  const fresh = await diagramToLaidOutXml(laneSamples["3 roles"]);
  const again = await layoutBpmnXml(fresh);
  const r4 = await analyse(again);
  const first = await analyse(fresh);
  check("edges survive re-layout", r4.edges.length === first.edges.length, r4.edges.length + " vs " + first.edges.length);
  check("no warnings on re-layout", r4.warnings === 0, "warnings=" + r4.warnings);

  const assocInput = {
    processId: "Proc_DB",
    processName: "Bestellung anlegen",
    lanes: [{ id: "l1", name: "Sachbearbeiter" }, { id: "l2", name: "Bestellsystem" }],
    nodes: [
      { id: "start_1", type: "startEvent", label: "Bestellung da", laneId: "l1" },
      { id: "task_1", type: "userTask", label: "Kundendaten prüfen", laneId: "l1" },
      { id: "task_2", type: "serviceTask", label: "Bestellung speichern", laneId: "l2" },
      { id: "store_1", type: "dataStoreReference", label: "Kundenstammdaten" },
      { id: "end_1", type: "endEvent", label: "Fertig", laneId: "l1" },
    ],
    edges: [
      { id: "e1", sourceId: "start_1", targetId: "task_1" },
      { id: "e2", sourceId: "task_1", targetId: "task_2" },
      { id: "e3", sourceId: "task_2", targetId: "end_1" },
    ],
    dataAssociations: [
      { id: "da1", nodeId: "task_1", dataNodeId: "store_1", direction: "read" },
      { id: "da2", nodeId: "task_2", dataNodeId: "store_1", direction: "write" },
    ],
  };

  const assocXml = await diagramToLaidOutXml(assocInput);
  const { rootElement: assocRoot, warnings: assocWarnings } = await new BpmnModdle().fromXML(assocXml);
  check("associations: no moddle warnings", assocWarnings.length === 0, "warnings=" + assocWarnings.length);
  check("associations: no junk attribute serialisation", !/="\[object Object\]"/.test(assocXml));

  const assocProc = assocRoot.get("rootElements").find((e) => e.$type === "bpmn:Process");
  const readAssoc = assocProc.get("flowElements").find((e) => e.id === "task_1").get("dataInputAssociations")[0];
  const writeAssoc = assocProc.get("flowElements").find((e) => e.id === "task_2").get("dataOutputAssociations")[0];
  check("read becomes a DataInputAssociation", readAssoc && readAssoc.$type === "bpmn:DataInputAssociation");
  check("read sourceRef is the data element", readAssoc && readAssoc.get("sourceRef")[0].id === "store_1");
  check("read targetRef is a generated DataInput", readAssoc && readAssoc.get("targetRef").$type === "bpmn:DataInput");
  check("write becomes a DataOutputAssociation", writeAssoc && writeAssoc.$type === "bpmn:DataOutputAssociation");
  check("write targetRef is the data element", writeAssoc && writeAssoc.get("targetRef").id === "store_1");
  check("write sourceRef is a generated DataOutput", writeAssoc && writeAssoc.get("sourceRef")[0].$type === "bpmn:DataOutput");

  const assocPlane = assocRoot.get("diagrams")[0].get("plane");
  const assocDiEdges = assocPlane.get("planeElement").filter((e) => {
    if (e.$type !== "bpmndi:BPMNEdge") return false;
    const t = e.get("bpmnElement").$type;
    return t === "bpmn:DataInputAssociation" || t === "bpmn:DataOutputAssociation";
  });
  check("both associations got a DI edge", assocDiEdges.length === 2, "edges=" + assocDiEdges.length);
  check("association DI edges have waypoints", assocDiEdges.every((e) => (e.get("waypoint") || []).length >= 2));
  const assocSegs = assocDiEdges.flatMap((e) => {
    const w = e.get("waypoint") || [];
    return w.slice(0, -1).map((p, i) => [p, w[i + 1]]);
  });
  check(
    "association segments are orthogonal",
    assocSegs.every(([a, b]) => a.x === b.x || a.y === b.y),
  );
  check(
    "association segments have a length",
    assocSegs.every(([a, b]) => a.x !== b.x || a.y !== b.y),
    "a repeated waypoint makes a zero-length segment",
  );

  // Association lines must not lie on top of the sequence flows.
  const seqDiEdges = assocPlane.get("planeElement").filter((e) => e.$type === "bpmndi:BPMNEdge" && e.get("bpmnElement").$type === "bpmn:SequenceFlow");
  const seqSegs = seqDiEdges.flatMap((e) => {
    const w = e.get("waypoint") || [];
    return w.slice(0, -1).map((p, i) => [p, w[i + 1]]);
  });
  let assocOverlap = 0;
  for (const [a1, a2] of assocSegs) {
    for (const [b1, b2] of seqSegs) {
      if (a1.y === a2.y && b1.y === b2.y && Math.abs(a1.y - b1.y) <= ALIGN) {
        const lo = Math.max(Math.min(a1.x, a2.x), Math.min(b1.x, b2.x));
        const hi = Math.min(Math.max(a1.x, a2.x), Math.max(b1.x, b2.x));
        if (hi - lo > OVERLAP) assocOverlap++;
      }
      if (a1.x === a2.x && b1.x === b2.x && Math.abs(a1.x - b1.x) <= ALIGN) {
        const lo = Math.max(Math.min(a1.y, a2.y), Math.min(b1.y, b2.y));
        const hi = Math.min(Math.max(a1.y, a2.y), Math.max(b1.y, b2.y));
        if (hi - lo > OVERLAP) assocOverlap++;
      }
    }
  }
  check("association lines do not overlap sequence flows", assocOverlap === 0, "overlaps=" + assocOverlap);

  const assocShapes = assocPlane.get("planeElement").filter((e) => e.$type === "bpmndi:BPMNShape");
  const storeShape = assocShapes.find((s) => s.get("bpmnElement").id === "store_1");
  const laneShapes2 = assocShapes.filter((s) => s.get("bpmnElement").$type === "bpmn:Lane");
  const laneRects2 = laneShapes2.map((s) => s.get("bounds"));
  check("data store has a shape", Boolean(storeShape));
  check(
    "data store is outside every lane",
    Boolean(storeShape) && laneRects2.every((l) => storeShape.get("bounds").y >= l.y + l.height - 1),
  );

  // Associations must also work without any lane at all.
  const noLaneAssoc = await diagramToLaidOutXml({
    processId: "Proc_NoLane",
    lanes: [],
    nodes: [
      { id: "s1", type: "startEvent", label: "Start" },
      { id: "t1", type: "userTask", label: "Speichern" },
      { id: "o1", type: "dataObjectReference", label: "Antrag" },
      { id: "e1", type: "endEvent", label: "Ende" },
    ],
    edges: [{ id: "e1", sourceId: "s1", targetId: "t1" }, { id: "e2", sourceId: "t1", targetId: "e1" }],
    dataAssociations: [{ id: "da1", nodeId: "t1", dataNodeId: "o1", direction: "write" }],
  });
  const { rootElement: noLaneRoot } = await new BpmnModdle().fromXML(noLaneAssoc);
  const noLanePlane = noLaneRoot.get("diagrams")[0].get("plane");
  const noLaneAssocEdges = noLanePlane.get("planeElement").filter((e) => {
    if (e.$type !== "bpmndi:BPMNEdge") return false;
    const t = e.get("bpmnElement").$type;
    return t === "bpmn:DataOutputAssociation";
  });
  check("association gets DI even without lanes", noLaneAssocEdges.length === 1, "edges=" + noLaneAssocEdges.length);

  // Regression: association routes repeated a point, so an edge carried two
  // identical consecutive waypoints - a segment of length zero.
  const assocOnly = [];
  for (const lanes of [[], [{ id: "l1", name: "Sachbearbeiter" }]]) {
    for (const storeCount of [1, 2, 4]) {
      const nodes = [
        { id: "t1", type: "userTask", label: "Prüfen", ...(lanes.length ? { laneId: "l1" } : {}) },
      ];
      for (let i = 1; i <= storeCount; i++) {
        nodes.push({ id: `d${i}`, type: "dataStoreReference", label: `Datenbank ${i}` });
      }
      assocOnly.push([
        `${storeCount} association(s), ${lanes.length ? "with" : "without"} lanes`,
        {
          processId: `Proc_Assoc_${lanes.length ? "Lane" : "NoLane"}_${storeCount}`,
          lanes,
          nodes,
          edges: [],
          dataAssociations: Array.from({ length: storeCount }, (_, index) => ({
            id: `da${index + 1}`,
            nodeId: "t1",
            dataNodeId: `d${index + 1}`,
            direction: index % 2 === 0 ? "read" : "write",
          })),
        },
      ]);
    }
  }
  for (const [name, input] of assocOnly) {
    const r = await analyse(await diagramToLaidOutXml(input));
    check(`${name}: no zero-length segments`, r.zeroLength === 0, "zeroLength=" + r.zeroLength);
  }

  const assocReject = [
    ["dataNodeId pointing at a task", { processId: "P", lanes: [], nodes: [{ id: "t1", type: "userTask", label: "A" }, { id: "t2", type: "userTask", label: "B" }], edges: [], dataAssociations: [{ id: "da1", nodeId: "t1", dataNodeId: "t2", direction: "read" }] }],
    ["nodeId pointing at an event", { processId: "P", lanes: [], nodes: [{ id: "s1", type: "startEvent", label: "S" }, { id: "d1", type: "dataStoreReference", label: "DB" }], edges: [], dataAssociations: [{ id: "da1", nodeId: "s1", dataNodeId: "d1", direction: "read" }] }],
    ["unknown direction", { processId: "P", lanes: [], nodes: [{ id: "t1", type: "userTask", label: "A" }, { id: "d1", type: "dataStoreReference", label: "DB" }], edges: [], dataAssociations: [{ id: "da1", nodeId: "t1", dataNodeId: "d1", direction: "delete" }] }],
    ["unknown nodeId", { processId: "P", lanes: [], nodes: [{ id: "d1", type: "dataStoreReference", label: "DB" }], edges: [], dataAssociations: [{ id: "da1", nodeId: "nope", dataNodeId: "d1", direction: "read" }] }],
    ["duplicate association", { processId: "P", lanes: [], nodes: [{ id: "t1", type: "userTask", label: "A" }, { id: "d1", type: "dataStoreReference", label: "DB" }], edges: [], dataAssociations: [{ id: "da1", nodeId: "t1", dataNodeId: "d1", direction: "read" }, { id: "da2", nodeId: "t1", dataNodeId: "d1", direction: "read" }] }],
  ];
  for (const [name, input] of assocReject) {
    let msg = "";
    try { parseDiagramInput(input); } catch (e) { msg = e.message; }
    check("rejects " + name, msg.length > 0, "no error raised");
  }

  let omittedOk = true;
  let parsedOmitted = null;
  try {
    parsedOmitted = parseDiagramInput({
      processId: "P", lanes: [{ id: "l1", name: "A" }],
      nodes: [{ id: "t1", type: "userTask", label: "A", laneId: "l1" }], edges: [],
    });
  } catch { omittedOk = false; }
  check("accepts input without dataAssociations", omittedOk);
  check("missing dataAssociations defaults to an empty list", Boolean(parsedOmitted) && parsedOmitted.dataAssociations.length === 0);

  assert.equal(
    failures.length,
    0,
    `failures: ${failures.length}\n` + failures.join("\n"),
  );
});
