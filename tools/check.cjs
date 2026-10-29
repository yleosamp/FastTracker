"use strict";
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const root = path.resolve(__dirname, "..");
for (const file of ["main.js", "core.cjs", "updates.cjs", "updates-ui.js", "engine/tracker.cjs", "engine/worker.cjs", "host/bridge.jsx", "tools/package.cjs"]) {
  new vm.Script(fs.readFileSync(path.join(root, file), "utf8"), { filename: file });
}
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
if (pkg.version !== lock.version || pkg.version !== lock.packages[""].version) throw new Error("Version mismatch");
console.log("Syntax and package metadata OK: FastTracker " + pkg.version);
