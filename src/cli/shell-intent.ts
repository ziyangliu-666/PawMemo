export type ShellIntent =
  | { kind: "command"; rawInput: string }
  | { kind: "planner"; text: string };

export function interpretShellInput(rawInput: string): ShellIntent {
  const input = rawInput.trim();

  if (input.startsWith("/")) {
    return {
      kind: "command",
      rawInput: input.slice(1)
    };
  }

  return {
    kind: "planner",
    text: input
  };
}
