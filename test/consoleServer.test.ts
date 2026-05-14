import { describe, expect, it } from "vitest";

import { buildConsoleAgentStatus, renderConsoleHtml } from "../src/consoleServer.js";

describe("console server UI", () => {
  it("renders language options and control actions", () => {
    const html = renderConsoleHtml();

    expect(html).toContain('id="language"');
    expect(html).toContain('value="en"');
    expect(html).toContain('value="zh-CN"');
    expect(html).toContain("English");
    expect(html).toContain('id="switch-model"');
    expect(html).toContain('id="run-diagnostics"');
    expect(html).toContain('id="detect-composer"');
    expect(html).toContain("api/desktop-model");
    expect(html).toContain("api/desktop-input/detect");
    expect(html).toContain("api/diagnostics");
    expect(html).toContain("api/failed/retry");
    expect(html).toContain("api/failed/discard");
    expect(html).toContain("api/failed/clear");
    expect(html).toContain("api/failed/archive");
    expect(html).toContain("agentMode");
    expect(html).toContain("agentQueue");
    expect(html).toContain("archiveFailures");
    expect(html).toContain("configHealth");
    expect(html).toContain("configRisks");
    expect(html).toContain("maxParallel");
    expect(html).toContain("selectedConversation");
    expect(html).toContain("clearFailures");
    expect(html).toContain("detectComposer");
    expect(html).toContain("failure-list");
    expect(html).toContain("panelHeading");
  });

  it("renders browser-parseable console JavaScript", () => {
    const html = renderConsoleHtml();
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];

    expect(script).toBeTruthy();
    expect(() => new Function(script)).not.toThrow();
  });

  it("defaults the local console to Simplified Chinese", () => {
    const html = renderConsoleHtml();

    expect(html).toContain('<html lang="zh-CN">');
    expect(html).toContain("<title>Codex 微信桥控制台</title>");
    expect(html).toContain('<h2 data-i18n="title">桥控制台</h2>');
    expect(html).toContain('<span data-i18n="language">语言</span>');
    expect(html).toContain('<button id="refresh" data-i18n="refresh">刷新</button>');
    expect(html).toContain('|| "zh-CN";');
    expect(html).toContain('language = "zh-CN";');
    expect(html).not.toContain('navigator.language && navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en"');
    expect(html).not.toContain('language = "en";');
  });

  it("summarizes console agent status for codex-cli multi-agent mode", () => {
    const status = buildConsoleAgentStatus({
      deliveryMode: "codex-cli",
      maxParallelRuns: 3
    } as any, {
      activeCount: 2,
      maxParallel: 3,
      queuedCount: 4,
      sessions: []
    });

    expect(status.mode).toBe("multi-agent");
    expect(status.maxParallel).toBe(3);
    expect(status.activeCount).toBe(2);
    expect(status.queuedCount).toBe(4);
  });

  it("summarizes Desktop UI as a single-owner agent lane", () => {
    const status = buildConsoleAgentStatus({
      deliveryMode: "desktop-ui",
      maxParallelRuns: 1
    } as any);

    expect(status.mode).toBe("desktop-single-lane");
    expect(status.maxParallel).toBe(1);
    expect(status.description).toContain("single");
  });
});
