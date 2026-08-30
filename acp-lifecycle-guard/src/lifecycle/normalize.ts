/**
 * Text normalization shared by classification and validation.
 *
 * Normalization is deliberately minimal. It only removes transport-level noise
 * that carries no lifecycle meaning:
 *
 * - CRLF / CR line endings become LF.
 * - Trailing newlines at the very end of the payload are dropped, because
 *   channel transports routinely add one.
 * - Emoji variation selectors (U+FE0F) are stripped so a renderer that omits
 *   the selector is not treated as layout drift.
 *
 * Everything else - leading blank lines, interior blank lines, trailing spaces,
 * section order - is preserved so the validator can reject it.
 */

const VARIATION_SELECTOR_16 = /\uFE0F/gu;

export function stripVariationSelectors(value: string): string {
  return value.replace(VARIATION_SELECTOR_16, "");
}

export function normalizeReportText(content: string): string {
  return stripVariationSelectors(
    content.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n"),
  ).replace(/\n+$/u, "");
}

export function toLines(normalized: string): string[] {
  return normalized.split("\n");
}

/** First line with visible content, `undefined` when the payload is blank. */
export function firstNonEmptyLine(normalized: string): string | undefined {
  for (const line of toLines(normalized)) {
    if (line.trim().length > 0) {
      return line;
    }
  }
  return undefined;
}

export function hasTrailingWhitespace(line: string): boolean {
  return /[ \t]$/u.test(line);
}
