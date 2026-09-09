export function splitQuizLabel(label: string): { meaning: string; reading: string; text: string } {
  const text = label.replace(/\s*[·-]\s*\d+\s*획.*$/u, "").trim();
  const primary = text.split(",")[0]?.trim() ?? "";
  const parenthesized = primary.match(/^(.+?)\s*[(（]\s*(.+?)\s*[)）]$/u);
  if (parenthesized) {
    const outside = parenthesized[1]!.trim();
    const inside = parenthesized[2]!.trim();
    const insideParts = inside.split(/\s+/u);
    if (insideParts.at(-1) === outside) {
      return { meaning: insideParts.slice(0, -1).join(" "), reading: outside, text };
    }
    const outsideParts = outside.split(/\s+/u);
    if (insideParts.length === 1) {
      // A dictionary entry such as "들보 량(양)" has an alternate reading.
      return outsideParts.length > 1
        ? { meaning: outsideParts.slice(0, -1).join(" "), reading: outsideParts.at(-1)!, text }
        : { meaning: outside, reading: inside, text };
    }
    return { meaning: inside, reading: outside, text };
  }
  const parts = primary.split(/\s+/u).filter(Boolean);
  return parts.length > 1
    ? { meaning: parts.slice(0, -1).join(" "), reading: parts.at(-1)!, text }
    : { meaning: primary, reading: "", text };
}
