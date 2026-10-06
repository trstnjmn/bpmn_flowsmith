const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const project = path.resolve(__dirname, "..");
const ts = require(require.resolve("typescript", { paths: [project] }));
const src = fs.readFileSync(path.join(project, "components/BpmnFlowSmith.tsx"), "utf8");

// Extract only the prompt-building region (self-contained, no React imports).
const start = src.indexOf('type OutputLanguage = "en" | "de";');
const end = src.indexOf("function downloadBpmn");
if (start < 0 || end < 0) throw new Error("markers not found");
const region = src.slice(start, end) + "\nexport const __test = { buildSystemPrompt, buildSearchPrompt, buildGuideSteps };\n";

const js = ts.transpileModule(region, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: "es2022" },
}).outputText;
const mod = { exports: {} };
new Function("exports", "module", "require", js)(mod.exports, mod, require);
const { buildSystemPrompt, buildSearchPrompt, buildGuideSteps } = mod.exports.__test;

const failures = [];
function check(name, ok, info) {
  if (ok) return;
  failures.push(info ? `${name} -> ${info}` : name);
}

test("prompt language and structure (en/de)", () => {
  const en = buildSystemPrompt("en");
  const de = buildSystemPrompt("de");

check("English and German prompts differ", en !== de);

for (const [name, prompt] of [["en", en], ["de", de]]) {
  // Rule numbering must stay 1..26, once each, in order.
  const nums = [...prompt.matchAll(/(?:^|\n)(\d+)\. /g)].map((m) => Number(m[1]));
  const expected = Array.from({ length: 26 }, (_, i) => i + 1);
  check(
    `${name}: rules numbered 1..26 in order`,
    JSON.stringify(nums) === JSON.stringify(expected),
    nums.join(","),
  );

  // The JSON schema block must be parseable JSON.
  const block = prompt.slice(prompt.indexOf("## 5. JSON SCHEMA"));
  const body = block.slice(block.indexOf("{"), block.lastIndexOf("}") + 1);
  let parsed = null;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    check(`${name}: example is valid JSON`, false, e.message);
  }
  if (parsed) {
    check(`${name}: example is valid JSON`, true);
    check(`${name}: example keeps the schema keys`, Object.keys(parsed).join(",") === "processId,processName,lanes,nodes,edges,dataAssociations");
    check(`${name}: example has 3 lanes`, parsed.lanes.length === 3);
    check(`${name}: example has 7 nodes`, parsed.nodes.length === 7);
    check(`${name}: example has 6 edges`, parsed.edges.length === 6);
    check(`${name}: example has 2 data associations`, parsed.dataAssociations.length === 2);
    check(
      `${name}: every gateway branch has a condition`,
      parsed.edges.filter((e) => e.sourceId === "gw_1").every((e) => Boolean(e.condition)),
    );
    check(
      `${name}: data node carries no laneId`,
      parsed.nodes.find((n) => n.type === "dataStoreReference") && !("laneId" in parsed.nodes.find((n) => n.type === "dataStoreReference")),
    );
  }
}

check("en: label rule asks for ENGLISH", en.includes("MUST be written in ENGLISH"));
check("de: label rule asks for GERMAN", de.includes("MUST be written in GERMAN"));
check("en: conditions asked for in English", en.includes('a "condition" in English'));
check("de: conditions asked for in German", de.includes('a "condition" in German'));
check("en: processName rule is English", en.includes('"processName" is the English process name'));
check("de: processName rule is German", de.includes('"processName" is the German process name'));
check("en: example labels are English", en.includes('"label": "Review request"'));
check("de: example labels are German", de.includes('"label": "Antrag prüfen"'));
check("en: example conditions are English", en.includes('"condition": "Yes"'));
check("de: example conditions are German", de.includes('"condition": "Ja"'));
check("en: example processId has no umlauts", en.includes('"processId": "Process_RequestReview"'));
check("en: no German example leftovers", !en.includes("Antragsprüfung") && !en.includes("Sachbearbeiter") && !en.includes('"Ja"') && !en.includes("Gültig") && !en.includes("Bestellsystem") && !en.includes("Buchhaltung"));
check("de: German examples intact", de.includes("Sachbearbeiter") && de.includes('"Ja"') && de.includes("Gültig") && de.includes("Bestellsystem"));
check("both: own placeholder token is present", /## 6\. PROCESS DESCRIPTION\nReplace the placeholder line below[^\n]*\n\[\[[A-Z ]+\]\]$/.test(en) && /## 6\. PROCESS DESCRIPTION\nReplace the placeholder line below[^\n]*\n\[\[[A-Z ]+\]\]$/.test(de));

// Both variants must keep the structural rules intact.
for (const [name, prompt] of [["en", en], ["de", de]]) {
  check(`${name}: data store rules kept`, prompt.includes("dataStoreReference") && prompt.includes("dataAssociations"));
  check(`${name}: lane rule kept`, prompt.includes("laneId"));
  check(`${name}: start event rule kept`, prompt.includes('Exactly one "startEvent" per process'));
  check(
    `${name}: prompt ends with the placeholder line`,
    new RegExp("## 6\\. PROCESS DESCRIPTION\\nReplace the placeholder line below[^\\n]*\\n\\[\\[[A-Z ]+\\]\\]$").test(prompt),
  );
  check(`${name}: no unresolved template holes`, !prompt.includes("undefined") && !prompt.includes("[object Object]") && !/\$\{/.test(prompt));
}

check("en: placeholder is the English token", en.includes("[[PROCESS DESCRIPTION]]"));
check("de: placeholder is the German token", de.includes("[[PROZESSBESCHREIBUNG]]"));
check("en: no German placeholder token left", !en.includes("[[PROZESSBESCHREIBUNG]]"));
check("de: no English placeholder token left", !de.includes("[[PROCESS DESCRIPTION]]"));
check("en: placeholder appears exactly once", en.split("[[PROCESS DESCRIPTION]]").length - 1 === 1);
check("de: placeholder appears exactly once", de.split("[[PROZESSBESCHREIBUNG]]").length - 1 === 1);

// The guide shown in the UI must name the placeholder that is actually in the prompt.
const enSteps = buildGuideSteps("[[PROCESS DESCRIPTION]]");
const deSteps = buildGuideSteps("[[PROZESSBESCHREIBUNG]]");
check("guide still has four steps", enSteps.length === 4 && deSteps.length === 4);
check("en guide names the English token", enSteps[0].description.includes("[[PROCESS DESCRIPTION]]") && !enSteps[0].description.includes("PROZESSBESCHREIBUNG"));
check("de guide names the German token", deSteps[0].description.includes("[[PROZESSBESCHREIBUNG]]") && !deSteps[0].description.includes("[[PROCESS DESCRIPTION]]"));
check("guide step titles stay English", enSteps.every((s, i) => s.title === deSteps[i].title));

// Section 3d: step depth.
for (const [name, prompt] of [["en", en], ["de", de]]) {
  check(`${name}: has the step-depth section`, prompt.includes("## 3d. STEP DEPTH"));
  check(`${name}: section order intact`, prompt.indexOf("## 3b.") < prompt.indexOf("## 3c.") && prompt.indexOf("## 3c.") < prompt.indexOf("## 3d.") && prompt.indexOf("## 3d.") < prompt.indexOf("## 4."));
  for (const [what, needle] of [
    ["state transition", "status or state transition"],
    ["persistence", "save, insert, update, delete"],
    ["external call", "HTTP or RPC client"],
    ["wait / approval", "human approval"],
    ["async continuation", "scheduled job"],
    ["gateway signals", "signal to emit a gateway instead"],
    ["anti-hallucination", "Split by evidence, never by imagination"],
    ["no invented micro-steps", "write log entry"],
    ["read method bodies", "method whose name hides its work"],
    ["silent self-check", "verify silently against the files you actually read"],
    ["loops are allowed", "justifies the exception in rule 16"],
    ["one node one action", 'label needs the word "and"'],
  ]) {
    check(`${name}: 3d covers ${what}`, prompt.includes(needle));
  }
  check(`${name}: 3d cross-referenced from section 1`, prompt.includes("section 3d defines what counts as distinct"));
  check(`${name}: rule 16 loop exception aligned`, prompt.includes("unless the description or the evidence explicitly states a loop"));
  check(`${name}: 3d mentions no double-counted nodes`, prompt.includes("never as a second copy of the same nodes"));
}
check("en: granularity example is English", en.includes('one method "createOrder" that validates the input, reserves stock and triggers the payment becomes THREE nodes ("Validate input data", "Reserve stock", "Trigger payment")'));
check("de: granularity example is German", de.includes('one method "Bestellung anlegen" that validates the input, reserves stock and triggers the payment becomes THREE nodes ("Eingangsdaten validieren", "Bestand reservieren", "Zahlung auslösen")'));

  assert.equal(
    failures.length,
    0,
    `failures: ${failures.length}\n` + failures.join("\n"),
  );
});

test("search prompt scans all processes, output language (en/de)", () => {
  const en = buildSearchPrompt("en");
  const de = buildSearchPrompt("de");

  const failures = [];
  function check(name, ok, info) {
    if (ok) return;
    failures.push(info ? `${name} -> ${info}` : name);
  }

  check("en and de search prompts differ", en !== de);

  for (const [name, prompt] of [["en", en], ["de", de]]) {
    check(`${name}: asks to scan the whole application once`, prompt.includes("scan the whole application once"));
    check(`${name}: asks for a numbered list`, prompt.includes("Reply with a numbered list, one entry per process"));
    check(`${name}: describes three lines per entry`, prompt.includes("Line 1:") && prompt.includes("Line 2:") && prompt.includes("Line 3:"));
    check(`${name}: forbids JSON output`, prompt.includes("No JSON, no code fences"));
    check(`${name}: keeps the project-search evidence list`, prompt.includes("state machines and status enums") && prompt.includes("grep, glob, read"));
    check(`${name}: asks not to guess`, prompt.includes("Do not guess from general knowledge"));
    check(`${name}: handles the empty result case`, prompt.includes("If the project contains no process"));
    check(`${name}: no unresolved template holes`, !prompt.includes("undefined") && !/\$\{/.test(prompt));
  }

  check("en: output written in ENGLISH", en.includes("written in ENGLISH"));
  check("de: output written in GERMAN", de.includes("written in GERMAN"));
  check("en: does not claim GERMAN output", !en.includes("written in GERMAN"));
  check("de: does not claim ENGLISH output", !de.includes("written in ENGLISH"));
  check("en: ends on the English output sentence", en.endsWith("Only the numbered list, in ENGLISH."));
  check("de: ends on the German output sentence", de.endsWith("Only the numbered list, in GERMAN."));

  assert.equal(
    failures.length,
    0,
    `failures: ${failures.length}\n` + failures.join("\n"),
  );
});