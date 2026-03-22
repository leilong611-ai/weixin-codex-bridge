import fs from "node:fs";

import { LOG_FILE, ensureLocalDir } from "./paths.mjs";

function format(level, message, extra) {
  const payload = {
    time: new Date().toISOString(),
    level,
    message,
    ...extra,
  };
  return JSON.stringify(payload);
}

export function log(level, message, extra = undefined) {
  const line = format(level, message, extra);
  ensureLocalDir();
  fs.appendFileSync(LOG_FILE, `${line}\n`, "utf-8");
  const prefix = `[${level}]`;
  if (level === "ERROR") {
    console.error(prefix, message);
    return;
  }
  console.log(prefix, message);
}

export function info(message, extra) {
  log("INFO", message, extra);
}

export function warn(message, extra) {
  log("WARN", message, extra);
}

export function error(message, extra) {
  log("ERROR", message, extra);
}
