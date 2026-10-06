import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const rootPath = fileURLToPath(root);
const actors = ["src/jira.ts", "dist/jira.js", "dist-test/src/jira.js"];
const unsupported = ["VIEW_ISSUES", "VIEW_WORKLOGS"];
const required = ["PROJECT_VIEW_ALL_WORKLOGS"];
const lifecycleNames = new Set(["preinstall", "install", "postinstall", "prepare"]);

async function walk(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }

  const found = [];
  for (const entry of entries) {
    if (entry.name === ".bin") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...await walk(path));
    } else if (entry.isFile() && entry.name === "package.json") {
      found.push(path);
    }
  }
  return found;
}

function allowlist(source) {
  const match = source.match(/(?:const|let)\s+accessPermissions\s*=\s*\[([\s\S]*?)\]/);
  if (!match) return null;
  return [...match[1].matchAll(/"([A-Z_]+)"/g)].map((item) => item[1]);
}

const permissionActors = [];
for (const name of actors) {
  let source;
  try {
    source = await readFile(new URL(`../${name}`, import.meta.url), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      permissionActors.push({ actor: name, present: false });
      continue;
    }
    throw error;
  }

  const permissions = allowlist(source);
  permissionActors.push({
    actor: name,
    present: true,
    permissions,
    unsupportedPresent: unsupported.filter((permission) => permissions?.includes(permission)),
    requiredMissing: required.filter((permission) => !permissions?.includes(permission)),
  });
}

const lifecycleOwners = [];
for (const manifestPath of await walk(join(rootPath, "node_modules"))) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const scripts = Object.fromEntries(Object.entries(manifest.scripts ?? {}).filter(([name]) => lifecycleNames.has(name)));
  if (Object.keys(scripts).length > 0) {
    lifecycleOwners.push({
      package: manifest.name ?? relative(rootPath, manifestPath),
      version: manifest.version ?? "unknown",
      manifest: relative(rootPath, manifestPath),
      scripts,
    });
  }
}

console.log(JSON.stringify({
  investigation: "Report permission state across source/build actors and installed dependency lifecycle scripts.",
  unsupportedPermissionIds: unsupported,
  requiredPermissionIds: required,
  actors: permissionActors,
  lifecycleOwners,
}, null, 2));
