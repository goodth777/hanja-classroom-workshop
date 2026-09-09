export interface HanjaLabelParts {
  meaning: string;
  reading: string;
  baseLabel: string;
}

function stripDuplicateReading(meaningWithReading: string, reading: string): string {
  const pieces = meaningWithReading.split(/\s+/u).filter(Boolean);
  if (reading && pieces.at(-1) === reading) return pieces.slice(0, -1).join(" ");
  return meaningWithReading.trim();
}

export function splitHanjaLabel(label?: string): HanjaLabelParts {
  const baseLabel = (label ?? "")
    .replace(/\s*[\u00B7\-]\s*\d+\uD68D.*$/u, "")
    .trim();
  const firstReading = baseLabel.split(",")[0]?.trim() ?? "";
  const parenthesized = firstReading.match(/^(.+?)\s*[\uFF08(]\s*(.+?)\s*[\uFF09)]$/u);
  if (parenthesized) {
    const outside = parenthesized[1]!.trim();
    const inside = parenthesized[2]!.trim();
    const insidePieces = inside.split(/\s+/u).filter(Boolean);
    const insideLast = insidePieces.at(-1) ?? "";
    if (insideLast === outside) {
      return { meaning: insidePieces.slice(0, -1).join(" ") || inside, reading: outside, baseLabel };
    }
    if (insidePieces.length === 1) {
      return { meaning: outside, reading: inside, baseLabel };
    }
    return { meaning: stripDuplicateReading(inside, outside), reading: outside, baseLabel };
  }
  const pieces = firstReading.split(/\s+/u).filter(Boolean);
  const reading = pieces.at(-1)?.replace(/[()]/g, "") ?? "";
  const meaning = pieces.slice(0, -1).join(" ");
  return { meaning, reading, baseLabel };
}
