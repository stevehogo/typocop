/**
 * Content-addressing hash helpers (A2).
 *
 * Cross-cutting, dependency-free (only `node:crypto`), so it lives in the
 * `platform/` layer where both `infrastructure/` adapters and `application/`
 * use-cases may import it without a layering violation.
 */
import { createHash } from "node:crypto";

/**
 * Hex-encoded SHA-256 digest of a UTF-8 string.
 *
 * Used by the parse cache (A2) to confirm staleness after the cheap `mtimeMs`
 * compare: identical content always yields the same digest, so a file that was
 * touched but not edited is detected as unchanged.
 */
export function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}
