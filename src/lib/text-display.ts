const ANSI_ESCAPE = String.fromCharCode(27);
const ANSI_REGEX = new RegExp(`${ANSI_ESCAPE}\\[[0-9;]*m`, "g");

function codePointWidth(codePoint: number): number {
  if (
    codePoint === 0 ||
    codePoint === 0x200d ||
    (codePoint >= 0x300 && codePoint <= 0x36f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
  ) {
    return 0;
  }

  if (
    codePoint >= 0x1100 &&
    (
      codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
      (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd)
    )
  ) {
    return 2;
  }

  return 1;
}

export function stringDisplayWidth(text: string): number {
  let width = 0;

  for (const char of text) {
    width += codePointWidth(char.codePointAt(0) ?? 0);
  }

  return width;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme"
});

export function splitGraphemes(text: string): string[] {
  return Array.from(graphemeSegmenter.segment(text), (entry) => entry.segment);
}

function firstGrapheme(text: string): string {
  return splitGraphemes(text)[0] ?? "";
}

function graphemeBoundaries(text: string): number[] {
  const boundaries = [0];

  for (const entry of graphemeSegmenter.segment(text)) {
    const end = entry.index + entry.segment.length;
    if (end > boundaries[boundaries.length - 1]) {
      boundaries.push(end);
    }
  }

  if (boundaries[boundaries.length - 1] !== text.length) {
    boundaries.push(text.length);
  }

  return boundaries;
}

export function clampToNearestGraphemeBoundary(text: string, cursor: number): number {
  const target = Math.max(0, Math.min(cursor, text.length));
  const boundaries = graphemeBoundaries(text);
  let best = boundaries[0] ?? 0;
  let bestDistance = Math.abs(best - target);

  for (const boundary of boundaries) {
    const distance = Math.abs(boundary - target);
    if (distance < bestDistance) {
      best = boundary;
      bestDistance = distance;
    }
  }

  return best;
}

export function previousGraphemeBoundary(text: string, cursor: number): number {
  const target = clampToNearestGraphemeBoundary(text, cursor);
  const boundaries = graphemeBoundaries(text);

  for (let index = boundaries.length - 1; index >= 0; index -= 1) {
    const boundary = boundaries[index];
    if (boundary !== undefined && boundary < target) {
      return boundary;
    }
  }

  return 0;
}

export function nextGraphemeBoundary(text: string, cursor: number): number {
  const target = clampToNearestGraphemeBoundary(text, cursor);
  const boundaries = graphemeBoundaries(text);

  for (const boundary of boundaries) {
    if (boundary > target) {
      return boundary;
    }
  }

  return text.length;
}

export function takeLeadingInputToken(buffer: string): string {
  if (buffer.length === 0) {
    return "";
  }

  const codePoint = buffer.codePointAt(0) ?? 0;
  if (codePoint < 0x20 || codePoint === 0x7f) {
    return String.fromCodePoint(codePoint);
  }

  return firstGrapheme(buffer);
}

export function normalizePastedText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function composerDisplayText(text: string): string {
  return text.replace(/\t/g, "  ").replace(/\n/g, "⏎");
}

export function visibleDisplayWidth(text: string): number {
  return stringDisplayWidth(text.replace(ANSI_REGEX, ""));
}
