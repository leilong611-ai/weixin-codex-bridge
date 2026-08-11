#!/usr/bin/env node

/**
 * Cross-platform public repository check.
 *
 * Replaces the Bash-only public-check.sh to avoid dependency on rg (ripgrep).
 * Scans tracked files for sensitive content patterns and disallowed file types.
 *
 * Usage: node scripts/public-check.mjs
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// ── Error tracking ──

let status = 0;
function fail(msg) {
  console.error("ERROR:", msg);
  status = 1;
}

// ── Get tracked files ──

function getTrackedFiles() {
  try {
    const out = execSync("git ls-files -z --cached --others --exclude-standard", {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    return out.split("\0").filter(Boolean);
  } catch {
    // Not in a git repo or no git — scan working directory
    console.error("WARNING: not in a git repository; scanning working directory");
    return walkDirSync(ROOT).filter((f) => {
      const lower = f.toLowerCase();
      return !lower.startsWith("node_modules") && !lower.startsWith(".git");
    });
  }
}

function walkDirSync(dir) {
  const results = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && entry.name !== "node_modules") {
          results.push(...walkDirSync(full));
        }
      } else {
        results.push(full);
      }
    }
  } catch { /* permission error */ }
  return results;
}

// ── Checks ──

const EXCLUDED_PATTERNS = [
  /\.env$/, /\.env\./,          // env files (keep .env.example)
  /node_modules\//, /\.git\//,
  /dist\//,
  /coverage\//,
  /\.local\//,
  /tmp\//, /temp\//,
  /logs?\//,
  /state\//,
  /\.openclaw\//,
  /debug\//,
  /screenshots?\//,
  /test\//,                     // test files contain intentional redaction test patterns
];

// Files in test/ that intentionally test redactor patterns are excluded.
// These files are not published to npm (files whitelist in package.json).

const FORBIDDEN_EXTENSIONS = [
  ".log", ".pid",
  ".sqlite", ".sqlite3", ".db", ".db-shm", ".db-wal",
  ".har", ".trace", ".webm",
];

const SENSITIVE_PATTERNS = [
  { label: "macOS user path", pattern: /\/Users\/[A-Za-z0-9._-]+/ },
  { label: "Linux home path", pattern: /\/home\/[A-Za-z0-9._-]+/ },
  { label: "Windows user path", pattern: /C:\\Users\\[A-Za-z0-9._-]+/ },
  { label: "Weixin bot id", pattern: /@im\.bot:[A-Za-z0-9._:-]{12,}/ },
  { label: "Weixin account id", pattern: /[A-Za-z0-9._-]{8,}@im\.wechat/ },
  { label: "Weixin wxid", pattern: /wxid_[A-Za-z0-9_-]{6,}/ },
  { label: "OpenAI-style API key", pattern: /\b(sk-[A-Za-z0-9]{20,}|pk-[A-Za-z0-9]{20,})\b/ },
  { label: "Slack-style token", pattern: /\b(xox[baprs]-[A-Za-z0-9-]{20,})\b/ },
  { label: "JSON token or cookie", pattern: /"(botToken|token|access_token|refresh_token|cookie)"\s*:\s*"[A-Za-z0-9._/+~=-]{16,}"/ },
  { label: "Environment token or cookie", pattern: /(^|[^A-Za-z])(BOT_TOKEN|WEIXIN_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|COOKIE)=[A-Za-z0-9._/+~=-]{16,}/ },
  { label: "QR query payload", pattern: /(qrcode|qr_code|login-qr)=[A-Za-z0-9_-]{16,}/ },
  { label: "Mainland China phone number", pattern: /\b1[3-9]\d{9}\b/ },
];

const FILE_CONTENT_CHECKS = [
  { label: "SQLite database file", pattern: /^SQLite format 3\0/ },
];

// ── Helper: read file content, handling binary ──

function isBinary(buf) {
  const scanLen = Math.min(buf.length, 8192);
  for (let i = 0; i < scanLen; i++) {
    const b = buf[i];
    if (b === 0 && !(i > 0 && buf[i - 1] === 0)) {
      return true;
    }
  }
  return false;
}

// ── Run checks ──

async function main() {
  const files = getTrackedFiles();

  for (const file of files) {
    const normalized = file.replace(/\\/g, "/");
    const lower = normalized.toLowerCase();

    // Skip excluded paths
    if (EXCLUDED_PATTERNS.some((p) => p.test(lower))) {
      continue;
    }

    // Check filename patterns
    if (lower.endsWith(".env") && !lower.endsWith(".env.example")) {
      fail(`Environment file is tracked: ${file}`);
    }

    // Check forbidden extensions
    const ext = path.extname(lower);
    if (FORBIDDEN_EXTENSIONS.includes(ext)) {
      fail(`Generated or diagnostic file is tracked: ${file}`);
    }

    // QR image patterns in filename
    if (/(^|\/)(login-)?qr(code)?[^/]*\.(png|jpe?g|webp|gif|svg)$/.test(lower)) {
      fail(`QR image is tracked: ${file}`);
    }

    // Debug/screenshot images
    if (/(^|\/).*(debug|screenshot|screen-shot|desktop-input).*\.(png|jpe?g|webp|gif|bmp)$/.test(lower)) {
      fail(`Debug screenshot/capture is tracked: ${file}`);
    }

    // Read file content
    let content;
    try {
      content = readFileSync(path.resolve(ROOT, file));
    } catch {
      continue;
    }

    // If binary, check database header
    const header = content.slice(0, 16);
    if (header.toString() === "SQLite format 3\0") {
      fail(`SQLite database file is tracked: ${file}`);
      continue;
    }

    // Skip binary files for text pattern checks
    if (isBinary(content)) {
      continue;
    }

    const text = content.toString("utf8");

    // Check sensitive patterns
    for (const { label, pattern } of SENSITIVE_PATTERNS) {
      // Skip example values in README/.env.example
      if (label === "Weixin wxid" && pattern.test(text)) {
        // Check if this is an obvious example value
        const examplePatterns = [/wxid_example/, /wxid_abcdef/];
        if (examplePatterns.some((p) => p.test(text))) {
          continue; // Allow example values in documentation
        }
      }
      const match = text.match(pattern);
      if (match) {
        // Get line number for the match
        const lines = text.split("\n");
        let lineNum = 0;
        for (let i = 0; i < lines.length; i++) {
          if (pattern.test(lines[i])) {
            lineNum = i + 1;
            break;
          }
        }
        // Show first match with line
        const excerpt = match[0].length > 80
          ? match[0].slice(0, 40) + "..." + match[0].slice(-40)
          : match[0];
        console.log(`  ${file}:${lineNum}: ${excerpt}`);
        fail(`Matched sensitive content pattern: ${label}`);
      }
    }
  }

  if (status !== 0) {
    console.error("\nPublic check failed. Found sensitive or forbidden content.");
    process.exit(status);
  }

  console.log(" Public check passed.");
}

main().catch((err) => {
  console.error("Public check error:", err.message);
  process.exit(1);
});
