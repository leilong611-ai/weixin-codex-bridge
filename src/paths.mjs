import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PROJECT_ROOT = path.resolve(__dirname, "..");
export const LOCAL_DIR = path.join(PROJECT_ROOT, ".local");
export const ACCOUNT_FILE = path.join(LOCAL_DIR, "account.json");
export const RUNTIME_FILE = path.join(LOCAL_DIR, "runtime.json");
export const SYNC_FILE = path.join(LOCAL_DIR, "sync.json");
export const LOG_FILE = path.join(LOCAL_DIR, "bridge.log");
export const LOGIN_QR_FILE = path.join(LOCAL_DIR, "login-qr.png");

export function ensureLocalDir() {
  fs.mkdirSync(LOCAL_DIR, { recursive: true });
}

export function resolveProjectPath(...parts) {
  return path.join(PROJECT_ROOT, ...parts);
}
