#!/usr/bin/env node
/**
 * Non-mutating marketplace manifest check.
 *
 * Mirrors the constraints OpenClaw applies when it loads a *remote* marketplace
 * (`src/plugins/marketplace.ts`): every plugin entry must use a relative path
 * source that stays inside the marketplace root. It additionally verifies that
 * each entry points at a real native plugin whose manifest id and version line
 * up with its `package.json`.
 *
 * Read-only: it never installs, enables, or writes anything.
 */

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const failures = [];
const notes = [];

function fail(message) {
  failures.push(message);
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

const manifestPath = path.join(repoRoot, "marketplace.json");
const manifest = readJson(manifestPath);
const catalogText = readFileSync(path.join(repoRoot, "README.md"), "utf8");
const catalogRows = catalogText
  .split("\n")
  .filter((line) => line.startsWith("|"))
  .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()))
  .filter(
    (cells) =>
      cells.length >= 4 &&
      cells[0] !== "Plugin" &&
      !cells.every((cell) => /^-+$/u.test(cell)),
  );

function unquoteCatalogCell(value) {
  return value?.replace(/^`(.*)`$/u, "$1");
}

if (typeof manifest.name !== "string" || manifest.name.length === 0) {
  fail("marketplace.json: missing name");
}
if (!Array.isArray(manifest.plugins) || manifest.plugins.length === 0) {
  fail("marketplace.json: missing plugins[]");
}

for (const entry of manifest.plugins ?? []) {
  const label = typeof entry?.name === "string" ? entry.name : "<unnamed>";

  if (typeof entry?.name !== "string" || entry.name.length === 0) {
    fail("marketplace entry: missing name");
    continue;
  }
  const source = entry.source;
  if (typeof source !== "string" || source.length === 0) {
    fail(`${label}: source must be a non-empty relative path string`);
    continue;
  }
  if (/^https?:\/\//i.test(source)) {
    fail(`${label}: remote marketplaces may not use HTTP(S) plugin paths`);
    continue;
  }
  if (path.isAbsolute(source)) {
    fail(`${label}: remote marketplaces may only use relative plugin paths`);
    continue;
  }

  const resolved = path.resolve(repoRoot, source);
  const relative = path.relative(repoRoot, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`)) {
    fail(`${label}: plugin source escapes marketplace root`);
    continue;
  }
  if (!statSync(resolved, { throwIfNoEntry: false })?.isDirectory()) {
    fail(`${label}: plugin source is not a directory in this repository`);
    continue;
  }

  const pluginManifestPath = path.join(resolved, "openclaw.plugin.json");
  const packageJsonPath = path.join(resolved, "package.json");
  if (!statSync(pluginManifestPath, { throwIfNoEntry: false })?.isFile()) {
    fail(`${label}: missing openclaw.plugin.json`);
    continue;
  }
  if (!statSync(packageJsonPath, { throwIfNoEntry: false })?.isFile()) {
    fail(`${label}: missing package.json`);
    continue;
  }

  const pluginManifest = readJson(pluginManifestPath);
  const packageJson = readJson(packageJsonPath);
  const catalogMatches = catalogRows.filter(
    (cells) => unquoteCatalogCell(cells[0]) === packageJson.name,
  );

  if (typeof pluginManifest.id !== "string" || pluginManifest.id.length === 0) {
    fail(`${label}: openclaw.plugin.json is missing id`);
  }
  if (
    pluginManifest.configSchema === undefined ||
    typeof pluginManifest.configSchema !== "object"
  ) {
    fail(`${label}: openclaw.plugin.json is missing configSchema`);
  }
  if (packageJson.name !== entry.name) {
    fail(
      `${label}: marketplace entry name does not match package.json name (${packageJson.name})`,
    );
  }
  if (entry.version !== undefined && entry.version !== packageJson.version) {
    fail(
      `${label}: marketplace entry version ${entry.version} does not match package.json ${packageJson.version}`,
    );
  }
  if (
    pluginManifest.version !== undefined &&
    pluginManifest.version !== packageJson.version
  ) {
    fail(
      `${label}: openclaw.plugin.json version ${pluginManifest.version} does not match package.json ${packageJson.version}`,
    );
  }
  if (catalogMatches.length !== 1) {
    fail(`${label}: root README catalog must contain exactly one plugin row`);
  } else {
    const [catalogName, catalogDirectory, catalogId, catalogVersion] =
      catalogMatches[0];
    const expectedDirectory = `${path.basename(resolved)}/`;
    if (unquoteCatalogCell(catalogName) !== packageJson.name) {
      fail(`${label}: root README catalog package name does not match`);
    }
    if (unquoteCatalogCell(catalogDirectory) !== expectedDirectory) {
      fail(`${label}: root README catalog directory does not match ${source}`);
    }
    if (unquoteCatalogCell(catalogId) !== pluginManifest.id) {
      fail(`${label}: root README catalog plugin id does not match manifest`);
    }
    if (unquoteCatalogCell(catalogVersion) !== packageJson.version) {
      fail(
        `${label}: root README catalog version ${unquoteCatalogCell(catalogVersion)} does not match package.json ${packageJson.version}`,
      );
    }
  }

  const extensions = packageJson.openclaw?.extensions;
  if (!Array.isArray(extensions) || extensions.length === 0) {
    fail(`${label}: package.json is missing openclaw.extensions`);
  } else if (extensions.some((entryPath) => !entryPath.startsWith("./dist/"))) {
    fail(
      `${label}: published runtime entries must point at built JavaScript under ./dist/`,
    );
  }

  notes.push(
    `${label}: id=${pluginManifest.id} version=${packageJson.version} source=${source}`,
  );
}

for (const note of notes) {
  console.log(`ok   ${note}`);
}
for (const failure of failures) {
  console.error(`fail ${failure}`);
}

if (failures.length > 0) {
  process.exitCode = 1;
} else {
  console.log(
    `ok   marketplace "${manifest.name}" lists ${manifest.plugins.length} plugin(s)`,
  );
}
