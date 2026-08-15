import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");

describe("release automation", () => {
  it("requires the newest completed successful GitHub Actions check", () => {
    const workflow = fs.readFileSync(
      path.join(root, ".github", "workflows", "release-verify.yml"),
      "utf8"
    );

    expect(workflow).toContain("per_page=100");
    expect(workflow).toContain('.app.slug == \\"github-actions\\"');
    expect(workflow).toContain("max_by(.id)");
    expect(workflow).toContain('status" != "completed"');
    expect(workflow).toContain('conclusion" != "success"');
    expect(workflow).not.toContain("sort_by(.completed_at)");
  });

  it("installs the generated tarball and runs its bin from an unrelated directory", () => {
    const verifier = fs.readFileSync(path.join(root, "scripts", "verify-pack.mjs"), "utf8");

    expect(verifier).toContain('"install"');
    expect(verifier).toContain("tarballPath");
    expect(verifier).toContain("unrelated-cwd");
    expect(verifier).toContain('binPath, ["help"]');
    expect(verifier).toContain('binPath, ["version"]');
    expect(verifier).toContain('binPath, ["doctor"]');
    expect(verifier).toContain("scripts/Send-CodexDesktopInput.ps1");
    expect(verifier).toContain("scripts/Set-CodexDesktopModel.ps1");
  });
});
