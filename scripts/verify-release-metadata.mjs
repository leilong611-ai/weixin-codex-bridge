#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = readJson("package.json");
const packageLock = readJson("package-lock.json");
const changelog = readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
const expectedVersion = (process.env.RELEASE_VERSION ?? packageJson.version)?.replace(/^v/, "");

if (typeof expectedVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(expectedVersion)) {
  fail("RELEASE_VERSION or package.json version must be a plain semantic version.");
}
if (packageJson.version !== expectedVersion) {
  fail(`package.json version ${packageJson.version} does not match ${expectedVersion}.`);
}
if (packageLock.version !== expectedVersion || packageLock.packages?.[""]?.version !== expectedVersion) {
  fail("package-lock.json root versions do not match package.json.");
}
if (packageJson.private !== true) {
  fail("package.json must remain private; this workflow does not authorize npm publication.");
}

const escapedVersion = expectedVersion.replace(/\./g, "\\.");
if (!new RegExp(`^## v${escapedVersion} — \\d{4}-\\d{2}-\\d{2}$`, "m").test(changelog)) {
  fail(`CHANGELOG.md needs a dated '## v${expectedVersion} — YYYY-MM-DD' heading.`);
}

console.log(`Release metadata verified for v${expectedVersion}.`);

function readJson(fileName) {
  return JSON.parse(readFileSync(path.join(root, fileName), "utf8"));
}

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}
