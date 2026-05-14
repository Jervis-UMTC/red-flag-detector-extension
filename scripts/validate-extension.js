import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const manifestPath = join(rootDir, "manifest.json");
const errors = [];

const manifest = readJson(manifestPath);

assert(manifest.manifest_version === 3, "manifest_version must be 3.");
assert(manifest.background?.service_worker, "A Manifest V3 service worker is required.");
assert(manifest.action?.default_popup, "The extension action must declare a popup.");
assert(Array.isArray(manifest.content_scripts), "content_scripts must be declared.");
assert(manifest.permissions?.includes("storage"), "storage permission is required for settings.");
assert(!manifest.permissions?.includes("tabs"), "tabs permission should not be requested for the MVP.");
assert(!manifest.host_permissions?.includes("<all_urls>"), "Do not request all host permissions.");

verifyManifestFile(manifest.action?.default_popup);
verifyManifestFile(manifest.background?.service_worker);

for (const contentScript of manifest.content_scripts ?? []) {
  for (const jsFile of contentScript.js ?? []) {
    verifyManifestFile(jsFile);
  }
  for (const cssFile of contentScript.css ?? []) {
    verifyManifestFile(cssFile);
  }
}

for (const resourceGroup of manifest.web_accessible_resources ?? []) {
  for (const resource of resourceGroup.resources ?? []) {
    verifyResourcePattern(resource);
  }
  for (const matchPattern of resourceGroup.matches ?? []) {
    verifyWebAccessibleResourceMatch(matchPattern);
  }
}

scanForUnsafePatterns(join(rootDir, "src"));

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log("Extension manifest and source checks passed.");

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    errors.push(`Could not read JSON at ${relative(path)}: ${error.message}`);
    return {};
  }
}

function verifyManifestFile(filePath) {
  if (!filePath) {
    return;
  }

  const fullPath = join(rootDir, filePath);
  assert(existsSync(fullPath), `Manifest references missing file: ${filePath}`);
}

function verifyResourcePattern(pattern) {
  if (!pattern) {
    return;
  }

  if (!pattern.includes("*")) {
    verifyManifestFile(pattern);
    return;
  }

  const folder = pattern.slice(0, pattern.lastIndexOf("/"));
  const suffix = pattern.slice(pattern.lastIndexOf("*") + 1);
  const fullFolder = join(rootDir, folder);

  assert(existsSync(fullFolder), `Manifest references missing folder: ${folder}`);
  if (!existsSync(fullFolder)) {
    return;
  }

  const matches = readdirSync(fullFolder).filter((entry) => entry.endsWith(suffix));
  assert(matches.length > 0, `Manifest resource pattern matched no files: ${pattern}`);
}

function verifyWebAccessibleResourceMatch(pattern) {
  try {
    const url = new URL(pattern.replace(/\*/gu, "wildcard"));
    assert(url.pathname === "/*" || url.pathname === "/wildcard", `web_accessible_resources match must use an origin path ending in /*: ${pattern}`);
  } catch {
    errors.push(`Invalid web_accessible_resources match pattern: ${pattern}`);
  }
}

function scanForUnsafePatterns(startPath) {
  for (const filePath of walk(startPath)) {
    if (!/\.(js|html)$/u.test(filePath)) {
      continue;
    }

    const source = readFileSync(filePath, "utf8");
    assert(!source.includes(".innerHTML"), `Avoid innerHTML in ${relative(filePath)}.`);
    assert(!source.includes("eval("), `Avoid eval in ${relative(filePath)}.`);
  }
}

function* walk(startPath) {
  for (const entry of readdirSync(startPath)) {
    const filePath = join(startPath, entry);
    const stats = statSync(filePath);
    if (stats.isDirectory()) {
      yield* walk(filePath);
    } else {
      yield filePath;
    }
  }
}

function assert(condition, message) {
  if (!condition) {
    errors.push(message);
  }
}

function relative(path) {
  return normalize(path).replace(normalize(rootDir), "").replace(/^[/\\]/u, "");
}
