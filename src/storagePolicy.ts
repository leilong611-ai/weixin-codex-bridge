/**
 * Unified storage policy for all runtime artifacts.
 *
 * Controls what the bridge preserves across restarts, based on
 * configurable log level and privacy settings.
 *
 * This is the SINGLE source of truth for storage decisions.
 * Individual modules (bridge, stateStore, codexRunner) must
 * query this policy rather than making their own log level checks.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export interface StoragePolicyConfig {
  logLevel: "minimal" | "metadata" | "full-debug";
  transcriptEnabled: boolean;
  storeFullPrompts: boolean;
  retentionDays: number;
}

/**
 * Storage policy — all methods return boolean decisions.
 */
export class StoragePolicy {
  constructor(private readonly config: StoragePolicyConfig) {}

  /** Should we store the full debug payload (raw_json)? */
  get keepFullDebugPayload(): boolean {
    return this.config.logLevel === "full-debug";
  }

  /** Should we store the extracted message text in SQLite? */
  get keepMessageText(): boolean {
    // In minimal/metadata we keep text in the durable envelope for crash recovery.
    // Terminal states clear it regardless.
    return true;
  }

  /** Should we create transcript files? */
  get keepTranscripts(): boolean {
    return this.config.transcriptEnabled;
  }

  /** Should we save the full prompt for retry? */
  get keepFullPrompts(): boolean {
    return this.config.storeFullPrompts;
  }

  /** Should we keep the full prompt hash + metadata for diagnostics? */
  get keepPromptMetadata(): boolean {
    return this.config.logLevel !== "minimal";
  }

  /** Should we keep full stdout/stderr from Codex runs? */
  get keepFullRunArtifacts(): boolean {
    return this.config.logLevel === "full-debug";
  }

  /** Should we keep the error message (redacted) in failed tasks? */
  get keepFailedTaskDetails(): boolean {
    return this.config.logLevel !== "minimal";
  }

  /** Should we save request.json with full prompt, args, and paths? */
  get keepFullRequestMetadata(): boolean {
    return this.config.logLevel === "full-debug";
  }

  /** Retention period in milliseconds */
  get retentionMs(): number {
    return this.config.retentionDays * 86_400_000;
  }
}

// ---------------------------------------------------------------------------
// Default policy
// ---------------------------------------------------------------------------

export const DEFAULT_STORAGE_POLICY: StoragePolicyConfig = {
  logLevel: "minimal",
  transcriptEnabled: false,
  storeFullPrompts: false,
  retentionDays: 7,
};
