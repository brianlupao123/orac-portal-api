import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

function run(command, args) {
  execFileSync(command, args, { stdio: "inherit", shell: process.platform === "win32" });
}

for (const file of ["README.md", "MAINTAINER_GUARDRAILS.md"]) {
  if ((await readFile(file, "utf8")).includes("Integrated Operations System")) throw new Error(`Stale ORAC-IOS name in ${file}`);
}
run("npm", ["test"]);
run("git", ["diff", "--check"]);
console.log("ORAC-IOS backend maintenance gate passed.");
