const fs = require("node:fs");
const path = require("node:path");

/**
 * The source under test is TypeScript, but the tests run plain `node --test`
 * without a build step or extra transpiler dependency (typescript is already
 * a devDependency). Each module is transpiled on the fly to CommonJS and
 * evaluated in a sandbox whose `require` resolves relative imports back into
 * this loader and bare imports against the project's node_modules.
 */
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const ts = require(require.resolve("typescript", { paths: [PROJECT_ROOT] }));

const cache = Object.create(null);

function load(rel, exp) {
  const file = path.isAbsolute(rel)
    ? rel
    : path.join(PROJECT_ROOT, rel.endsWith(".ts") ? rel : `${rel}.ts`);
  if (cache[file]) return exp ? cache[file].exports[exp] : cache[file].exports;

  const js = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: "es2022" },
    fileName: file,
  }).outputText;

  const m = { exports: {} };
  cache[file] = m;

  const req = (r) => {
    if (r.startsWith(".")) {
      const next = path.join(path.dirname(path.relative(PROJECT_ROOT, file)), r);
      return load(next, null);
    }
    return require(require.resolve(r, { paths: [PROJECT_ROOT] }));
  };

  new Function("exports", "require", "module", js)(m.exports, req, m);
  return exp ? m.exports[exp] : m.exports;
}

module.exports = { PROJECT_ROOT, load };
