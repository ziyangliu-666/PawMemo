import {
  splitGraphemes,
  stringDisplayWidth
} from "./text-display";

export function fitComposerViewport(
  before: string,
  after: string,
  maxWidth: number
): {
  before: string;
  after: string;
} {
  const beforeParts = splitGraphemes(before);
  const afterParts = splitGraphemes(after);
  let trimmedStart = false;
  let trimmedEnd = false;

  const currentWidth = () =>
    stringDisplayWidth(beforeParts.join("")) +
    stringDisplayWidth(afterParts.join("")) +
    (trimmedStart ? 1 : 0) +
    (trimmedEnd ? 1 : 0);

  while (currentWidth() > maxWidth) {
    if (beforeParts.length > 0) {
      beforeParts.shift();
      trimmedStart = true;
      continue;
    }

    if (afterParts.length > 0) {
      afterParts.pop();
      trimmedEnd = true;
      continue;
    }

    break;
  }

  return {
    before: `${trimmedStart ? "…" : ""}${beforeParts.join("")}`,
    after: `${afterParts.join("")}${trimmedEnd ? "…" : ""}`
  };
}

export function wrapDisplayText(text: string, maxWidth: number): string[] {
  const normalized = text.replace(/\t/g, "  ");

  if (maxWidth <= 0) {
    return [normalized];
  }

  if (normalized.trim().length === 0) {
    return [""];
  }

  const words = normalized.split(" ");
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;

    if (stringDisplayWidth(candidate) <= maxWidth) {
      current = candidate;
      continue;
    }

    if (current.length > 0) {
      lines.push(current);
      current = word;
      continue;
    }

    let chunk = "";
    for (const char of splitGraphemes(word)) {
      const chunkCandidate = `${chunk}${char}`;
      if (stringDisplayWidth(chunkCandidate) <= maxWidth) {
        chunk = chunkCandidate;
      } else {
        if (chunk.length > 0) {
          lines.push(chunk);
        }
        chunk = char;
      }
    }
    current = chunk;
  }

  if (current.length > 0) {
    lines.push(current);
  }

  return lines.length > 0 ? lines : [normalized];
}

export function wrapDisplayTextWithPrefixes(
  text: string,
  firstLineWidth: number,
  continuationWidth: number
): string[] {
  const normalized = text.replace(/\t/g, "  ");

  if (firstLineWidth <= 0 || continuationWidth <= 0) {
    return [normalized];
  }

  if (normalized.trim().length === 0) {
    return [""];
  }

  const lines: string[] = [];

  const cutFittingPrefix = (value: string, maxWidth: number): string => {
    let chunk = "";

    for (const char of splitGraphemes(value)) {
      const candidate = `${chunk}${char}`;
      if (stringDisplayWidth(candidate) > maxWidth) {
        break;
      }
      chunk = candidate;
    }

    return chunk;
  };

  const wrapLogicalLine = (
    sourceLine: string,
    startingWidth: number
  ): string[] => {
    if (sourceLine.length === 0) {
      return [""];
    }

    const output: string[] = [];
    const tokens = sourceLine.match(/\S+|\s+/g) ?? [sourceLine];
    let current = "";
    let currentWidth = startingWidth;

    for (const token of tokens) {
      if (/^\s+$/.test(token)) {
        if (current.length === 0) {
          continue;
        }

        const candidate = `${current}${token}`;
        if (stringDisplayWidth(candidate) <= currentWidth) {
          current = candidate;
          continue;
        }

        output.push(current.trimEnd());
        current = "";
        currentWidth = continuationWidth;
        continue;
      }

      let remaining = token;

      while (remaining.length > 0) {
        const candidate = `${current}${remaining}`;
        if (stringDisplayWidth(candidate) <= currentWidth) {
          current = candidate;
          remaining = "";
          continue;
        }

        if (current.length > 0) {
          output.push(current.trimEnd());
          current = "";
          currentWidth = continuationWidth;
          continue;
        }

        const chunk = cutFittingPrefix(remaining, currentWidth);
        if (chunk.length === 0) {
          break;
        }
        output.push(chunk);
        remaining = remaining.slice(chunk.length);
        currentWidth = continuationWidth;
      }
    }

    if (current.length > 0) {
      output.push(current.trimEnd());
    }

    return output.length > 0 ? output : [""];
  };

  let currentWidth = firstLineWidth;

  normalized.split("\n").forEach((sourceLine) => {
    const wrapped = wrapLogicalLine(sourceLine, currentWidth);
    lines.push(...wrapped);
    currentWidth = continuationWidth;
  });

  return lines.length > 0 ? lines : [normalized];
}

export function tailDisplayText(text: string, maxWidth: number): string {
  if (stringDisplayWidth(text) <= maxWidth) {
    return text;
  }

  let out = "";
  const reversed = splitGraphemes(text).reverse();

  for (const char of reversed) {
    const candidate = `${char}${out}`;
    if (stringDisplayWidth(candidate) > maxWidth - 1) {
      break;
    }
    out = candidate;
  }

  return `…${out}`;
}

export function fitDisplayLine(text: string, columns: number): string {
  if (stringDisplayWidth(text) <= columns) {
    return text;
  }

  let out = "";
  for (const char of splitGraphemes(text)) {
    const candidate = `${out}${char}`;
    if (stringDisplayWidth(`${candidate}…`) > columns) {
      break;
    }
    out = candidate;
  }

  return `${out}…`;
}

export function centerDisplayLine(text: string, columns: number): string {
  const fitted = fitDisplayLine(text, columns);
  const missingWidth = Math.max(0, columns - stringDisplayWidth(fitted));
  const leftPadding = Math.floor(missingWidth / 2);
  const rightPadding = missingWidth - leftPadding;

  return `${" ".repeat(leftPadding)}${fitted}${" ".repeat(rightPadding)}`;
}
