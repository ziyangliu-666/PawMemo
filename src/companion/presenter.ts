import { renderCompanionDefaultLine } from "./packs";
import type { CompanionPackDefinition, CompanionSnapshot } from "./types";

const AVATAR_GAP = 1;
const MIN_AVATAR_SLOT_WIDTH = 6;
const MAX_TEXT_WIDTH = 44;

function renderCompanionAvatar(
  pack: CompanionPackDefinition,
  snapshot: CompanionSnapshot
): string {
  const frames = pack.avatarFrames[snapshot.mood] ?? pack.avatarFrames.idle;
  const fallbackFrame = "( companion missing )";

  if (!frames || frames.length === 0) {
    return fallbackFrame;
  }

  return frames[Math.abs(snapshot.frame) % frames.length] ?? frames[0] ?? fallbackFrame;
}

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

function stringDisplayWidth(text: string): number {
  let width = 0;

  for (const char of text) {
    width += codePointWidth(char.codePointAt(0) ?? 0);
  }

  return width;
}

function resolveAvatarSlotWidth(pack: CompanionPackDefinition): number {
  let width = 0;

  for (const frames of Object.values(pack.avatarFrames)) {
    if (!frames) {
      continue;
    }

    for (const frame of frames) {
      width = Math.max(width, stringDisplayWidth(frame));
    }
  }

  return Math.max(width, MIN_AVATAR_SLOT_WIDTH);
}

function padAvatar(text: string, width: number): string {
  const padding = Math.max(0, width - stringDisplayWidth(text));
  return `${text}${" ".repeat(padding)}`;
}

function wrapText(text: string, maxWidth: number): string[] {
  const normalized = text.trim().replace(/\s+/g, " ");

  if (normalized.length === 0) {
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

    lines.push(word);
  }

  if (current.length > 0) {
    lines.push(current);
  }

  return lines.length > 0 ? lines : [normalized];
}

function defaultLine(
  pack: CompanionPackDefinition,
  snapshot: CompanionSnapshot
): string {
  if (snapshot.lineOverride) {
    return snapshot.lineOverride;
  }

  return renderCompanionDefaultLine(
    pack,
    snapshot.mood,
    {
      dueCount: snapshot.dueCount,
      recentWord: snapshot.recentWord
    },
    snapshot.frame
  );
}

export function renderCompanionPresenceLine(
  pack: CompanionPackDefinition,
  snapshot: CompanionSnapshot
): string {
  const headerLabel = pack.styleLabel ?? pack.archetype ?? snapshot.mood;
  const avatar = renderCompanionAvatar(pack, snapshot);
  return `${pack.displayName} · ${headerLabel} · ${avatar}  ${defaultLine(pack, snapshot)}`;
}

export function renderCompanionCard(
  pack: CompanionPackDefinition,
  snapshot: CompanionSnapshot
): string {
  const headerLabel = pack.styleLabel ?? pack.archetype ?? snapshot.mood;
  const avatar = renderCompanionAvatar(pack, snapshot);
  const avatarWidth = resolveAvatarSlotWidth(pack);
  const avatarSlot = padAvatar(avatar, avatarWidth);
  const textLines = wrapText(defaultLine(pack, snapshot), MAX_TEXT_WIDTH);
  const continuationIndent = " ".repeat(avatarWidth + AVATAR_GAP);
  const bodyLines = textLines.map((line, index) =>
    index === 0 ? `${avatarSlot}${" ".repeat(AVATAR_GAP)}${line}` : `${continuationIndent}${line}`
  );

  return [
    `[ ${pack.displayName} · ${headerLabel} ]`,
    ...bodyLines
  ].join("\n");
}
