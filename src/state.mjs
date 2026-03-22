import fs from "node:fs";

import { ACCOUNT_FILE, RUNTIME_FILE, SYNC_FILE, ensureLocalDir } from "./paths.mjs";

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  ensureLocalDir();
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

export function loadAccount() {
  return readJson(ACCOUNT_FILE, null);
}

export function saveAccount(account) {
  writeJson(ACCOUNT_FILE, {
    ...account,
    savedAt: new Date().toISOString(),
  });
}

export function clearAccount() {
  try {
    fs.unlinkSync(ACCOUNT_FILE);
  } catch {}
}

export function loadRuntime() {
  return readJson(RUNTIME_FILE, {});
}

export function saveRuntime(runtime) {
  writeJson(RUNTIME_FILE, runtime);
}

export function loadSyncCursor() {
  const state = readJson(SYNC_FILE, {});
  return typeof state.get_updates_buf === "string" ? state.get_updates_buf : "";
}

export function saveSyncCursor(getUpdatesBuf) {
  writeJson(SYNC_FILE, { get_updates_buf: getUpdatesBuf ?? "" });
}

export function clearSyncCursor() {
  try {
    fs.unlinkSync(SYNC_FILE);
  } catch {}
}
