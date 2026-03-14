import fs from "node:fs";
import zlib from "node:zlib";

import {
  splitGraphemes,
  stringDisplayWidth
} from "../lib/text-display";
import type { ShellHarnessSnapshot } from "./shell-harness";

type Rgb = {
  r: number;
  g: number;
  b: number;
};

type CellStyle = {
  fg: Rgb;
  bg: Rgb;
  bold: boolean;
};

type RenderCell = {
  text: string;
  width: number;
  style: CellStyle;
};

type PsfFont = {
  width: number;
  height: number;
  glyphs: Uint8Array[];
  glyphIndexByCodePoint: Map<number, number>;
};

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47,
  0x0d, 0x0a, 0x1a, 0x0a
]);
const ANSI_SGR_PATTERN = new RegExp(`^${String.fromCharCode(27)}\\[([0-9;]*)m`);

const DEFAULT_BG: Rgb = { r: 15, g: 18, b: 25 };
const DEFAULT_FG: Rgb = { r: 229, g: 231, b: 235 };
const DEFAULT_PADDING_X = 16;
const DEFAULT_PADDING_Y = 18;
const CELL_GAP_X = 1;
const CELL_GAP_Y = 2;

let cachedFont: PsfFont | null | undefined;
let cachedCrcTable: Uint32Array | null = null;

function clampChannel(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function rgb(r: number, g: number, b: number): Rgb {
  return {
    r: clampChannel(r),
    g: clampChannel(g),
    b: clampChannel(b)
  };
}

function luminance(color: Rgb): number {
  return (color.r * 0.2126) + (color.g * 0.7152) + (color.b * 0.0722);
}

function chooseCursorColor(style: CellStyle): Rgb {
  return luminance(style.bg) > 128 ? rgb(24, 24, 27) : rgb(250, 250, 250);
}

function pickShellFontPath(): string | null {
  const candidates = [
    "/usr/share/consolefonts/Lat15-TerminusBold16.psf.gz",
    "/usr/share/consolefonts/Lat15-Terminus16.psf.gz",
    "/usr/share/consolefonts/Lat2-Terminus16.psf.gz",
    "/usr/share/consolefonts/Uni1-VGA16.psf.gz",
    "/usr/share/consolefonts/Uni1-VGA8.psf.gz"
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function loadShellFont(): PsfFont | null {
  if (cachedFont !== undefined) {
    return cachedFont;
  }

  const fontPath = pickShellFontPath();
  if (!fontPath) {
    cachedFont = null;
    return cachedFont;
  }

  const fontBuffer = zlib.gunzipSync(fs.readFileSync(fontPath));
  cachedFont =
    parsePsf2(fontBuffer) ??
    parsePsf1(fontBuffer) ??
    null;
  return cachedFont;
}

function parsePsf1(buffer: Buffer): PsfFont | null {
  if (buffer.length < 4 || buffer[0] !== 0x36 || buffer[1] !== 0x04) {
    return null;
  }

  const mode = buffer[2] ?? 0;
  const charSize = buffer[3] ?? 0;
  const glyphCount = (mode & 0x01) !== 0 ? 512 : 256;
  const hasUnicodeTable = (mode & 0x02) !== 0;
  const glyphBytes = glyphCount * charSize;

  if (charSize === 0 || buffer.length < 4 + glyphBytes) {
    return null;
  }

  const glyphs: Uint8Array[] = [];
  for (let index = 0; index < glyphCount; index += 1) {
    const start = 4 + (index * charSize);
    const end = start + charSize;
    glyphs.push(buffer.subarray(start, end));
  }

  const glyphIndexByCodePoint = new Map<number, number>();
  for (let index = 0; index < Math.min(128, glyphCount); index += 1) {
    glyphIndexByCodePoint.set(index, index);
  }

  if (hasUnicodeTable) {
    let offset = 4 + glyphBytes;
    let glyphIndex = 0;

    while (offset + 1 < buffer.length && glyphIndex < glyphCount) {
      const value = buffer.readUInt16LE(offset);
      offset += 2;

      if (value === 0xffff) {
        glyphIndex += 1;
        continue;
      }

      if (value === 0xfffe) {
        continue;
      }

      glyphIndexByCodePoint.set(value, glyphIndex);
    }
  }

  return {
    width: 8,
    height: charSize,
    glyphs,
    glyphIndexByCodePoint
  };
}

function parsePsf2(buffer: Buffer): PsfFont | null {
  if (buffer.length < 32 || buffer.readUInt32LE(0) !== 0x864ab572) {
    return null;
  }

  const headerSize = buffer.readUInt32LE(8);
  const flags = buffer.readUInt32LE(12);
  const glyphCount = buffer.readUInt32LE(16);
  const charSize = buffer.readUInt32LE(20);
  const height = buffer.readUInt32LE(24);
  const width = buffer.readUInt32LE(28);
  const glyphBytes = glyphCount * charSize;

  if (
    glyphCount === 0 ||
    charSize === 0 ||
    width === 0 ||
    height === 0 ||
    buffer.length < headerSize + glyphBytes
  ) {
    return null;
  }

  const glyphs: Uint8Array[] = [];
  for (let index = 0; index < glyphCount; index += 1) {
    const start = headerSize + (index * charSize);
    const end = start + charSize;
    glyphs.push(buffer.subarray(start, end));
  }

  const glyphIndexByCodePoint = new Map<number, number>();
  for (let index = 0; index < Math.min(128, glyphCount); index += 1) {
    glyphIndexByCodePoint.set(index, index);
  }

  if ((flags & 0x01) !== 0) {
    let glyphIndex = 0;
    let offset = headerSize + glyphBytes;
    let sequence: number[] = [];

    while (offset < buffer.length && glyphIndex < glyphCount) {
      const byte = buffer[offset] ?? 0;
      offset += 1;

      if (byte === 0xff) {
        for (const codePoint of sequence) {
          glyphIndexByCodePoint.set(codePoint, glyphIndex);
        }
        sequence = [];
        glyphIndex += 1;
        continue;
      }

      if (byte === 0xfe) {
        sequence = [];
        continue;
      }

      const utf8Length =
        (byte & 0x80) === 0 ? 1 :
        (byte & 0xe0) === 0xc0 ? 2 :
        (byte & 0xf0) === 0xe0 ? 3 :
        (byte & 0xf8) === 0xf0 ? 4 :
        1;
      const end = Math.min(buffer.length, offset + utf8Length - 1);
      const bytes = Buffer.from([byte, ...buffer.subarray(offset, end)]);
      offset = end;
      const decoded = bytes.toString("utf8");

      for (const char of decoded) {
        const codePoint = char.codePointAt(0);
        if (codePoint !== undefined) {
          sequence.push(codePoint);
        }
      }
    }
  }

  return {
    width,
    height,
    glyphs,
    glyphIndexByCodePoint
  };
}

function ansi16Color(code: number, bright: boolean): Rgb {
  const palette = bright
    ? [
        rgb(85, 85, 85),
        rgb(248, 113, 113),
        rgb(74, 222, 128),
        rgb(250, 204, 21),
        rgb(96, 165, 250),
        rgb(232, 121, 249),
        rgb(34, 211, 238),
        rgb(250, 250, 250)
      ]
    : [
        rgb(24, 24, 27),
        rgb(239, 68, 68),
        rgb(34, 197, 94),
        rgb(234, 179, 8),
        rgb(59, 130, 246),
        rgb(217, 70, 239),
        rgb(6, 182, 212),
        rgb(229, 231, 235)
      ];

  return palette[code] ?? DEFAULT_FG;
}

function ansi256Color(index: number): Rgb {
  if (index < 16) {
    return ansi16Color(index % 8, index >= 8);
  }

  if (index >= 232) {
    const value = 8 + ((index - 232) * 10);
    return rgb(value, value, value);
  }

  const cubeIndex = index - 16;
  const r = Math.floor(cubeIndex / 36) % 6;
  const g = Math.floor(cubeIndex / 6) % 6;
  const b = cubeIndex % 6;
  const cube = [0, 95, 135, 175, 215, 255];

  return rgb(cube[r] ?? 0, cube[g] ?? 0, cube[b] ?? 0);
}

function parseSgrCodes(codes: number[], style: CellStyle): CellStyle {
  const next: CellStyle = {
    fg: style.fg,
    bg: style.bg,
    bold: style.bold
  };

  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index] ?? 0;

    if (code === 0) {
      next.fg = DEFAULT_FG;
      next.bg = DEFAULT_BG;
      next.bold = false;
      continue;
    }

    if (code === 1) {
      next.bold = true;
      continue;
    }

    if (code === 22) {
      next.bold = false;
      continue;
    }

    if (code >= 30 && code <= 37) {
      next.fg = ansi16Color(code - 30, false);
      continue;
    }

    if (code >= 90 && code <= 97) {
      next.fg = ansi16Color(code - 90, true);
      continue;
    }

    if (code === 39) {
      next.fg = DEFAULT_FG;
      continue;
    }

    if (code >= 40 && code <= 47) {
      next.bg = ansi16Color(code - 40, false);
      continue;
    }

    if (code >= 100 && code <= 107) {
      next.bg = ansi16Color(code - 100, true);
      continue;
    }

    if (code === 49) {
      next.bg = DEFAULT_BG;
      continue;
    }

    if ((code === 38 || code === 48) && codes[index + 1] === 5) {
      const paletteIndex = codes[index + 2];

      if (typeof paletteIndex === "number") {
        if (code === 38) {
          next.fg = ansi256Color(paletteIndex);
        } else {
          next.bg = ansi256Color(paletteIndex);
        }
      }

      index += 2;
    }
  }

  return next;
}

function parseStyledLineToCells(
  line: string,
  columns: number
): Array<RenderCell | null> {
  const cells: Array<RenderCell | null> = Array.from({ length: columns }, () => null);
  let style: CellStyle = {
    fg: DEFAULT_FG,
    bg: DEFAULT_BG,
    bold: false
  };
  let visibleColumn = 0;

  for (let index = 0; index < line.length && visibleColumn < columns;) {
    if (line[index] === "\u001b" && line[index + 1] === "[") {
      const match = ANSI_SGR_PATTERN.exec(line.slice(index));
      if (match) {
        const codes = match[1]
          ?.split(";")
          .filter((value) => value.length > 0)
          .map((value) => Number.parseInt(value, 10))
          .filter((value) => Number.isFinite(value)) ?? [0];
        style = parseSgrCodes(codes.length > 0 ? codes : [0], style);
        index += match[0].length;
        continue;
      }
    }

    const remaining = line.slice(index);
    const grapheme = splitGraphemes(remaining)[0];
    if (!grapheme) {
      break;
    }

    const width = Math.max(1, Math.min(2, stringDisplayWidth(grapheme)));
    for (let offset = 0; offset < width && visibleColumn + offset < columns; offset += 1) {
      cells[visibleColumn + offset] = offset === 0
        ? {
            text: grapheme,
            width,
            style
          }
        : null;
    }

    visibleColumn += width;
    index += grapheme.length;
  }

  for (let column = 0; column < columns; column += 1) {
    if (cells[column] === null) {
      cells[column] = {
        text: "",
        width: 1,
        style
      };
    }
  }

  return cells;
}

function writePixel(
  pixels: Uint8ClampedArray,
  width: number,
  x: number,
  y: number,
  color: Rgb,
  alpha = 255
): void {
  if (x < 0 || y < 0) {
    return;
  }

  const index = ((y * width) + x) * 4;
  if (index < 0 || index + 3 >= pixels.length) {
    return;
  }

  pixels[index] = color.r;
  pixels[index + 1] = color.g;
  pixels[index + 2] = color.b;
  pixels[index + 3] = alpha;
}

function fillRect(
  pixels: Uint8ClampedArray,
  width: number,
  x: number,
  y: number,
  rectWidth: number,
  rectHeight: number,
  color: Rgb
): void {
  for (let row = 0; row < rectHeight; row += 1) {
    for (let column = 0; column < rectWidth; column += 1) {
      writePixel(pixels, width, x + column, y + row, color);
    }
  }
}

function glyphForText(font: PsfFont | null, text: string): Uint8Array | null {
  if (!font || text.length === 0) {
    return null;
  }

  const codePoint = text.codePointAt(0);
  if (codePoint === undefined) {
    return null;
  }

  const glyphIndex = font.glyphIndexByCodePoint.get(codePoint);
  if (glyphIndex === undefined) {
    return null;
  }

  return font.glyphs[glyphIndex] ?? null;
}

function drawPlaceholderGlyph(
  pixels: Uint8ClampedArray,
  width: number,
  x: number,
  y: number,
  boxWidth: number,
  boxHeight: number,
  color: Rgb
): void {
  for (let column = 0; column < boxWidth; column += 1) {
    writePixel(pixels, width, x + column, y, color);
    writePixel(pixels, width, x + column, y + boxHeight - 1, color);
  }

  for (let row = 0; row < boxHeight; row += 1) {
    writePixel(pixels, width, x, y + row, color);
    writePixel(pixels, width, x + boxWidth - 1, y + row, color);
  }

  const diagonal = Math.min(boxWidth, boxHeight);
  for (let offset = 0; offset < diagonal; offset += 1) {
    writePixel(pixels, width, x + offset, y + offset, color);
    writePixel(pixels, width, x + boxWidth - offset - 1, y + offset, color);
  }
}

function drawGlyph(
  pixels: Uint8ClampedArray,
  imageWidth: number,
  x: number,
  y: number,
  drawWidth: number,
  drawHeight: number,
  color: Rgb,
  font: PsfFont | null,
  text: string
): void {
  const glyph = glyphForText(font, text);
  if (!glyph || !font) {
    drawPlaceholderGlyph(
      pixels,
      imageWidth,
      x,
      y,
      Math.max(3, drawWidth - 2),
      Math.max(5, drawHeight - 2),
      color
    );
    return;
  }

  const bytesPerRow = Math.ceil(font.width / 8);
  const scaleX = Math.max(1, Math.floor(drawWidth / font.width));
  const scaleY = Math.max(1, Math.floor(drawHeight / font.height));
  const offsetX = x + Math.max(0, Math.floor((drawWidth - (font.width * scaleX)) / 2));
  const offsetY = y + Math.max(0, Math.floor((drawHeight - (font.height * scaleY)) / 2));

  for (let row = 0; row < font.height; row += 1) {
    for (let column = 0; column < font.width; column += 1) {
      const byte = glyph[(row * bytesPerRow) + Math.floor(column / 8)] ?? 0;
      const bit = 0x80 >> (column % 8);
      if ((byte & bit) === 0) {
        continue;
      }

      for (let dy = 0; dy < scaleY; dy += 1) {
        for (let dx = 0; dx < scaleX; dx += 1) {
          writePixel(
            pixels,
            imageWidth,
            offsetX + (column * scaleX) + dx,
            offsetY + (row * scaleY) + dy,
            color
          );
        }
      }
    }
  }
}

function getCrcTable(): Uint32Array {
  if (cachedCrcTable) {
    return cachedCrcTable;
  }

  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0
        ? 0xedb88320 ^ (value >>> 1)
        : value >>> 1;
    }
    table[index] = value >>> 0;
  }

  cachedCrcTable = table;
  return table;
}

function crc32(bytes: Buffer): number {
  const table = getCrcTable();
  let crc = 0xffffffff;

  for (const value of bytes) {
    crc = table[(crc ^ value) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, "ascii");
  const lengthBuffer = Buffer.alloc(4);
  lengthBuffer.writeUInt32BE(data.length, 0);
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);

  return Buffer.concat([lengthBuffer, typeBuffer, data, crcBuffer]);
}

function encodePng(width: number, height: number, pixels: Uint8ClampedArray): Buffer {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);

  for (let row = 0; row < height; row += 1) {
    const filterIndex = row * (stride + 1);
    raw[filterIndex] = 0;
    const sourceStart = row * stride;
    const sourceEnd = sourceStart + stride;
    Buffer.from(pixels.subarray(sourceStart, sourceEnd)).copy(raw, filterIndex + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

export function renderShellSnapshotToPng(
  snapshot: ShellHarnessSnapshot
): Buffer {
  const font = loadShellFont();
  const glyphWidth = font?.width ?? 8;
  const glyphHeight = font?.height ?? 16;
  const cellWidth = glyphWidth + 2 + CELL_GAP_X;
  const cellHeight = glyphHeight + 4 + CELL_GAP_Y;
  const columns = snapshot.frame.viewport.columns;
  const rows = snapshot.frame.rendered.lines.length;
  const imageWidth = (columns * cellWidth) + (DEFAULT_PADDING_X * 2);
  const imageHeight = (rows * cellHeight) + (DEFAULT_PADDING_Y * 2);
  const pixels = new Uint8ClampedArray(imageWidth * imageHeight * 4);

  fillRect(pixels, imageWidth, 0, 0, imageWidth, imageHeight, DEFAULT_BG);

  const cellsByRow = snapshot.frame.rendered.styledLines.map((line) =>
    parseStyledLineToCells(line, columns)
  );

  for (let row = 0; row < rows; row += 1) {
    const rowCells = cellsByRow[row] ?? [];
    const y = DEFAULT_PADDING_Y + (row * cellHeight);

    for (let column = 0; column < columns; column += 1) {
      const cell = rowCells[column];
      const x = DEFAULT_PADDING_X + (column * cellWidth);
      const style = cell?.style ?? {
        fg: DEFAULT_FG,
        bg: DEFAULT_BG,
        bold: false
      };

      fillRect(pixels, imageWidth, x, y, cellWidth, cellHeight, style.bg);

      if (cell && cell.text.length > 0) {
        const widthInCells = Math.max(1, cell.width);
        drawGlyph(
          pixels,
          imageWidth,
          x + 1,
          y + 2,
          (cellWidth * widthInCells) - 2,
          cellHeight - 4,
          style.fg,
          font,
          cell.text
        );
      }
    }
  }

  const cursor = snapshot.frame.rendered.cursor;
  if (cursor?.visible) {
    const cursorRow = cursor.row;
    const cursorColumn = cursor.column;

    if (cursorRow >= 0 && cursorRow < rows && cursorColumn >= 0 && cursorColumn < columns) {
      const cell = cellsByRow[cursorRow]?.[cursorColumn];
      const style = cell?.style ?? {
        fg: DEFAULT_FG,
        bg: DEFAULT_BG,
        bold: false
      };
      const cursorX = DEFAULT_PADDING_X + (cursorColumn * cellWidth);
      const cursorY = DEFAULT_PADDING_Y + (cursorRow * cellHeight);
      fillRect(
        pixels,
        imageWidth,
        cursorX,
        cursorY + cellHeight - 3,
        cellWidth - 1,
        2,
        chooseCursorColor(style)
      );
    }
  }

  return encodePng(imageWidth, imageHeight, pixels);
}
