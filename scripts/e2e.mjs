/* Headless e2e smoke: built CLI must answer --version, modes, sandbox, execpolicy. */
import { execFileSync } from "child_process";
import * as path from "path";

const entry = path.join("dist", "apps", "cli", "src", "index.js");
function run(...args) {
  return execFileSync("node", [entry, ...args], { encoding: "utf8", timeout: 30_000 });
}
const v = run("--version");
if (!v.includes("trayambak")) throw new Error("version smoke failed: " + v);
run("modes");
run("sandbox", "check", "package.json");
run("execpolicy", "check", "npm test");
console.log("e2e smoke ok:", v.trim());
