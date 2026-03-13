import { UsageError } from "../lib/errors";

const BOOLEAN_FLAGS = new Set(["tui"]);

export interface ParsedCommand {
  name: string;
  args: string[];
  flags: Record<string, string>;
}

export function parseCommand(argv: string[]): ParsedCommand {
  const [name, ...rest] = argv;

  if (!name) {
    throw new UsageError("A command is required. Try `pawmemo capture ...`.");
  }

  const args: string[] = [];
  const flags: Record<string, string> = {};

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];

    if (token.startsWith("--")) {
      const key = token.slice(2);
      const value = rest[index + 1];

      if (!value || value.startsWith("--")) {
        if (BOOLEAN_FLAGS.has(key)) {
          flags[key] = "true";
          continue;
        }

        throw new UsageError(`Missing value for --${key}.`);
      }

      flags[key] = value;
      index += 1;
      continue;
    }

    args.push(token);
  }

  return {
    name,
    args,
    flags
  };
}

export function tokenizeCommandLine(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escape = false;

  for (const char of input) {
    if (escape) {
      current += char;
      escape = false;
      continue;
    }

    if (char === "\\") {
      escape = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escape) {
    current += "\\";
  }

  if (quote) {
    throw new UsageError("Unclosed quote in shell command.");
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}
