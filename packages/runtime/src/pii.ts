/**
 * Light-touch PII redaction shared across the OCR worker and the
 * frame builder (which now also handles raw AX text from capture).
 * Both paths must apply the same scrub before text lands in storage.
 *
 * We err on the side of preserving meaning:
 *  - Email addresses → [REDACTED_EMAIL]
 *  - 13–19 digit sequences (cards) → [REDACTED_CARD]
 *  - Lines containing any configured sensitive keyword → [REDACTED_LINE]
 *
 * Bigger / smarter PII detection (NER, spaCy) is V2.
 */
export function redactPii(text: string, sensitiveKeywords: string[]): string {
  if (!text) return text;
  let out = text;
  out = out.replace(
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    '[REDACTED_EMAIL]',
  );
  out = out.replace(/\b(?:\d[ -]?){13,19}\b/g, (m) => {
    const digits = m.replace(/[^\d]/g, '');
    if (digits.length < 13 || digits.length > 19) return m;
    return '[REDACTED_CARD]';
  });
  if (sensitiveKeywords.length > 0) {
    const escaped = sensitiveKeywords
      .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .filter((k) => k.length > 0);
    if (escaped.length > 0) {
      const pattern = new RegExp(`^.*(?:${escaped.join('|')}).*$`, 'gim');
      out = out.replace(pattern, '[REDACTED_LINE]');
    }
  }
  return out;
}
