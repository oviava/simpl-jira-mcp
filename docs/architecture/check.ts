/** Rerunnable architecture and runtime catalog checks. This does not replace TypeScript 7 compilation. */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const sketchDir = import.meta.dirname;
const root = resolve(sketchDir, "../..");
function requireCheck(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const same = (values: (string | undefined)[]) => JSON.stringify([...values].sort());
function catalogKeys(source: string, declaration: string): string[] {
  const marker = `export const ${declaration} = {`;
  const start = source.indexOf(marker);
  requireCheck(start >= 0, `${declaration} declaration is missing`);
  const bodyStart = start + marker.length;
  const end = source.indexOf("} as const;", bodyStart);
  requireCheck(end >= 0, `${declaration} catalog end is missing`);
  return [...source.slice(bodyStart, end).matchAll(/^  (jira_[a-z_]+):/gm)].map(match => match[1] ?? "");
}

const schemas = read("docs/architecture/schemas.ts");
const contracts = read("docs/architecture/contracts.ts");
const runtimeSchemas = read("src/schemas.ts");
const runtimeServer = read("src/server.ts");
const toolData = contracts.match(/export type ToolData = \{([\s\S]*?)\n\};/);
requireCheck(toolData !== null, "ToolData declaration is missing");
const inputs = [...schemas.matchAll(/^  (jira_[a-z_]+):/gm)].map(match => match[1]);
const outputs = [...(toolData?.[1] ?? "").matchAll(/^  (jira_[a-z_]+):/gm)].map(match => match[1]);
const methods = [...contracts.matchAll(/input: ToolInput<"(jira_[a-z_]+)">/g)].map(match => match[1]);
requireCheck(inputs.length === 29 && new Set(inputs).size === 29, "Expected 29 distinct staged tool schemas");
requireCheck(same(inputs) === same(outputs), "Input and output catalogs differ");
requireCheck(same(inputs) === same(methods), "Client signatures and tool catalog differ");

const runtimeInputs = catalogKeys(runtimeSchemas, "inputSchemas");
const runtimeOutputs = catalogKeys(runtimeSchemas, "outputSchemas");
const registered = [...runtimeServer.matchAll(/server\.registerTool\("(jira_[a-z_]+)"\s*,\s*toolConfig\("(jira_[a-z_]+)"/g)];
const registeredNames = registered.map(match => match[1] ?? "");
requireCheck(same(runtimeInputs) === same(runtimeOutputs), "Runtime input and output catalogs differ");
requireCheck(registered.length === registeredNames.length && new Set(registeredNames).size === registeredNames.length,
  "Runtime tool registrations are missing, malformed, or duplicated");
requireCheck(registered.every(match => match[1] === match[2]), "A registered tool uses a different schema key");
requireCheck(registeredNames.every(name => runtimeInputs.includes(name)), "A registered tool has no runtime schemas");

// These are the explicit implementation gates recorded in the runtime plan.
const gatedWrites = [
  "jira_create_issue", "jira_update_issue", "jira_add_comment", "jira_assign_issue",
  "jira_transition_issue", "jira_link_issues",
];
const stagedOnly = inputs.filter(name => !runtimeInputs.includes(name));
const unadvertisedRuntimeTools = runtimeInputs.filter(name => !registeredNames.includes(name));
requireCheck(same(stagedOnly) === same(gatedWrites), "Staged/runtime gaps differ from the six documented write gates");
requireCheck(same(unadvertisedRuntimeTools) === same(["jira_read_attachment"]),
  "Unregistered runtime tools differ from the attachment gate");
requireCheck(same(registeredNames) === same(runtimeInputs.filter(name => !unadvertisedRuntimeTools.includes(name))),
  "Registered runtime tools differ from the declared attachment gate");

const sourceFiles = readdirSync(sketchDir).filter(file => file.endsWith(".ts"));
for (const file of sourceFiles) {
  const result = spawnSync(process.execPath, ["--check", resolve(sketchDir, file)], { encoding: "utf8" });
  requireCheck(result.status === 0, `Syntax check failed for ${file}: ${result.stderr}`);
}
const documents = ["README.md", "docs/mcp-implementation-plan.md", "docs/jira-capability-report.md",
  "docs/mcp-architecture.md", "docs/architecture/README.md", "docs/architecture/rationale.md"];
for (const file of documents) {
  const text = read(file);
  const fences = text.match(/^```/gm) ?? [];
  requireCheck(fences.length % 2 === 0, `Unbalanced Markdown fences in ${file}`);
  requireCheck(!/probe-jira\.py|summarize-jira\.py|python3/.test(text), `Retired script reference in ${file}`);
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const target = match[1];
    if (target === undefined || /^[a-z]+:|^#/.test(target)) continue;
    const path = target.split("#")[0];
    requireCheck(path !== undefined && existsSync(resolve(dirname(resolve(root, file)), path)),
      `Broken local link in ${file}: ${target}`);
  }
}
requireCheck(!existsSync(resolve(root, "scripts/probe-jira.py")), "Retired probe still exists");
requireCheck(!existsSync(resolve(root, "scripts/summarize-jira.py")), "Retired summarizer still exists");
JSON.parse(read("docs/jira-discovery-evidence.json"));
console.log(JSON.stringify({
  syntaxChecked: sourceFiles,
  stagedContracts: inputs.length,
  runtimeInputSchemas: runtimeInputs.length,
  runtimeOutputSchemas: runtimeOutputs.length,
  registeredTools: registeredNames.length,
  unadvertisedRuntimeTools,
  unimplementedStagedTools: stagedOnly,
  documentsChecked: documents.length,
  investigationEvidence: "valid JSON", typeCompilation: "not verified",
}, null, 2));
