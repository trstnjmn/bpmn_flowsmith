const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const project = path.resolve(__dirname, "..");
const ts = require(require.resolve("typescript", { paths: [project] }));
const src = fs.readFileSync(path.join(project, "components/BpmnFlowSmith.tsx"), "utf8");
const region = src.slice(src.indexOf('type OutputLanguage = "en" | "de";'), src.indexOf("function downloadBpmn"))
  + "\nexport const __t = { readStoredOutputLanguage, storeOutputLanguage, subscribeToOutputLanguage, OUTPUT_LANGUAGE_STORAGE_KEY };\n";

const js = ts.transpileModule(region, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: "es2022" },
}).outputText;

const failures = [];
function check(name, ok, info) {
  if (ok) return;
  failures.push(info ? `${name} -> ${info}` : name);
}

test("output language store (localStorage and cross-tab)", () => {

function makeWindow(store, { throwOnAccess = false } = {}) {
  const target = new EventTarget();
  return {
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
    localStorage: throwOnAccess
      ? {
          getItem() { throw new Error("blocked"); },
          setItem() { throw new Error("blocked"); },
        }
      : {
          getItem: (k) => (k in store ? store[k] : null),
          setItem: (k, v) => { store[k] = String(v); },
        },
  };
}

function loadWith(windowStub) {
  const mod = { exports: {} };
  const fn = new Function("exports", "module", "require", "window", js);
  fn(mod.exports, mod, require, windowStub);
  return mod.exports.__t;
}

const KEY = "flowsmith.outputLanguage";

// 1. Default with empty storage.
{
  const win = makeWindow({});
  const { readStoredOutputLanguage } = loadWith(win);
  check("defaults to English when nothing is stored", readStoredOutputLanguage() === "en", readStoredOutputLanguage());
}

// 2. Round trip.
{
  const store = {};
  const win = makeWindow(store);
  const { readStoredOutputLanguage, storeOutputLanguage, OUTPUT_LANGUAGE_STORAGE_KEY } = loadWith(win);
  check("storage key is stable", OUTPUT_LANGUAGE_STORAGE_KEY === KEY, OUTPUT_LANGUAGE_STORAGE_KEY);
  storeOutputLanguage("de");
  check("stored German is read back", readStoredOutputLanguage() === "de");
  check("writes under the expected key", store[KEY] === "de", JSON.stringify(store));
  storeOutputLanguage("en");
  check("switching back to English works", readStoredOutputLanguage() === "en");
}

// 3. A value written by an earlier session is honoured.
{
  const win = makeWindow({ [KEY]: "de" });
  const { readStoredOutputLanguage } = loadWith(win);
  check("restores a persisted choice", readStoredOutputLanguage() === "de");
}

// 4. Corrupt / foreign values fall back instead of leaking through.
{
  for (const bad of ["fr", "", "EN", "deutsch", "de;drop"]) {
    const win = makeWindow({ [KEY]: bad });
    const { readStoredOutputLanguage } = loadWith(win);
    check(`rejects stored value ${JSON.stringify(bad)}`, readStoredOutputLanguage() === "en", readStoredOutputLanguage());
  }
}

// 5. Subscription fires on same-tab change and on cross-tab storage event.
{
  const win = makeWindow({});
  const { subscribeToOutputLanguage, storeOutputLanguage } = loadWith(win);
  let calls = 0;
  const unsubscribe = subscribeToOutputLanguage(() => { calls++; });
  storeOutputLanguage("de");
  check("same-tab write notifies subscribers", calls === 1, "calls=" + calls);
  win.dispatchEvent(new Event("storage"));
  check("cross-tab storage event notifies subscribers", calls === 2, "calls=" + calls);
  unsubscribe();
  storeOutputLanguage("en");
  check("unsubscribe stops notifications", calls === 2, "calls=" + calls);
}

// 6. Blocked storage must not crash the app.
{
  const win = makeWindow({}, { throwOnAccess: true });
  const { readStoredOutputLanguage, storeOutputLanguage, subscribeToOutputLanguage } = loadWith(win);
  let read = "threw";
  let wrote = false;
  try { read = readStoredOutputLanguage(); } catch { read = "threw"; }
  try { subscribeToOutputLanguage(() => {})(); storeOutputLanguage("de"); wrote = true; } catch { wrote = false; }
  check("falls back to English when storage is blocked", read === "en", String(read));
  check("setting a language survives blocked storage", wrote);
}

  assert.equal(
    failures.length,
    0,
    `failures: ${failures.length}\n` + failures.join("\n"),
  );
});