/**
 * Simple token estimation utilities.
 *
 * Uses a heuristic word/char-based approach for fast estimation
 * without requiring a full tokenizer dependency.
 */

/**
 * Estimate the number of tokens in a string.
 *
 * Heuristic: ~4 characters per token for English,
 * ~2 characters per token for CJK (Chinese/Japanese/Korean).
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;

  let tokens = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    // CJK Unified Ideographs and extensions
    if (
      (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified
      (code >= 0x3400 && code <= 0x4dbf) || // CJK Extension A
      (code >= 0x20000 && code <= 0x2a6df) || // CJK Extension B
      (code >= 0x2a700 && code <= 0x2b73f) || // CJK Extension C
      (code >= 0xf900 && code <= 0xfaff) || // CJK Compat
      (code >= 0x3000 && code <= 0x303f) || // CJK Symbols
      (code >= 0xff00 && code <= 0xffef) // Fullwidth Forms
    ) {
      tokens += 0.5; // ~2 chars per token for CJK
    } else {
      tokens += 0.25; // ~4 chars per token for Latin
    }
  }

  // At least 1 token for non-empty text
  return Math.max(1, Math.ceil(tokens));
}

/**
 * Calculate total tokens for a list of messages.
 */
export function totalTokens(
  messages: Array<{ content: string; tokenCount?: number }>,
): number {
  return messages.reduce(
    (sum, msg) => sum + (msg.tokenCount ?? estimateTokens(msg.content)),
    0,
  );
}

/**
 * Format a token count for display (e.g., "128K", "1.2M").
 */
export function formatTokenCount(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`;
  }
  if (count >= 1_000) {
    return `${(count / 1_000).toFixed(1)}K`;
  }
  return String(count);
}
