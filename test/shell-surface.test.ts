import test from "node:test";
import assert from "node:assert/strict";

import {
  LineShellSurface,
  TuiShellSurface,
  type ShellTerminal
} from "../src/cli/shell-surface";

class FakeShellTerminal implements ShellTerminal {
  readonly writes: string[] = [];
  readonly rawWrites: string[] = [];
  readonly prompts: string[] = [];

  constructor(
    private readonly inputs: string[],
    readonly supportsColor = false
  ) {}

  write(text: string): void {
    this.writes.push(text);
  }

  writeRaw(text: string): void {
    this.rawWrites.push(text);
  }

  async prompt(promptText: string): Promise<string> {
    this.prompts.push(promptText);
    return this.inputs.shift() ?? "/quit";
  }

  close(): void {}
}

test("LineShellSurface renders the shell header and intro copy", () => {
  const terminal = new FakeShellTerminal([]);
  const surface = new LineShellSurface(terminal);

  surface.beginShell("Momo");

  assert.equal(terminal.writes[0], "Momo · Chat");
});

test("LineShellSurface streams assistant replies when raw writes are available", async () => {
  const terminal = new FakeShellTerminal([]);
  const surface = new LineShellSurface(terminal);

  await surface.writeAssistantReply("你好 PawMemo");

  assert.deepEqual(terminal.writes, []);
  assert.equal(terminal.rawWrites.join(""), "你好 PawMemo\n");
});

test("LineShellSurface renders and clears a transient waiting indicator through raw writes", () => {
  const terminal = new FakeShellTerminal([]);
  const surface = new LineShellSurface(terminal);

  surface.showWaitingIndicator("Momo", "Give me a beat.");
  surface.clearWaitingIndicator();

  const output = terminal.rawWrites.join("");
  assert.match(output, /Momo/);
  assert.match(output, /Give me a beat\./);
  assert.ok(output.includes("\u001b[2K"));
});

test("LineShellSurface creates a review terminal that proxies prompts and writes", async () => {
  const terminal = new FakeShellTerminal(["good"]);
  const surface = new LineShellSurface(terminal);
  const reviewTerminal = surface.createReviewSessionTerminal();

  reviewTerminal.write("First up: luminous");
  reviewTerminal.writeDataBlock?.("Locked in as good.", "review-session-status-success", {
    kind: "review-summary",
    title: "summary"
  });
  const response = await reviewTerminal.prompt("Grade: ");

  assert.equal(response, "good");
  assert.deepEqual(terminal.writes, ["First up: luminous", "Locked in as good."]);
  assert.deepEqual(terminal.prompts, ["Grade: "]);
});

test("TuiShellSurface enters alternate screen and renders a four-part shell frame", () => {
  const terminal = new FakeShellTerminal([]);
  const surface = new TuiShellSurface(terminal);

  surface.beginShell("Momo");
  surface.writeAssistantReplyNow("Hello from transcript");
  surface.close();

  const output = terminal.rawWrites.join("");
  assert.ok(output.includes("\u001b[?1049h"));
  assert.match(output, /Momo · Chat/);
  assert.match(output, /› █/);
  assert.match(output, /Hello from transcript/);
  assert.ok(output.includes("\u001b[?1049l"));
});

test("TuiShellSurface shows waiting in the transient status row without appending transcript", () => {
  const terminal = new FakeShellTerminal([]);
  const surface = new TuiShellSurface(terminal);

  surface.beginShell("Momo");
  surface.showWaitingIndicator("Momo", "Lining up the next step.");
  surface.clearWaitingIndicator();
  surface.close();

  const output = terminal.rawWrites.join("");
  assert.match(output, /Momo {2}Lining up the next step\./);
  assert.doesNotMatch(output, /companion card/i);
});

test("TuiShellSurface styles review-oriented transcript lines as study cells", () => {
  const terminal = new FakeShellTerminal([], true);
  const surface = new TuiShellSurface(terminal);

  surface.beginShell("Momo");
  surface.writeDataBlock("Okay, here comes a short review lap.", "review-session-heading");
  surface.writeDataBlock("First up: luminous", "review-card-heading");
  surface.writeDataBlock("What we were looking for: emitting light", "plain");
  surface.writeDataBlock("Nice. We did 1 card and paused there.", "review-summary");
  surface.close();

  const output = terminal.rawWrites.join("");
  assert.match(output, /Okay, here comes a short review lap\./);
  assert.match(output, /First up: luminous/);
  assert.match(output, /What we were looking for: emitting light/);
  assert.match(output, /Nice\. We did 1 card and paused there\./);
});

test("TuiShellSurface accepts explicit study intent from the review terminal", () => {
  const terminal = new FakeShellTerminal([], true);
  const surface = new TuiShellSurface(terminal);
  const reviewTerminal = surface.createReviewSessionTerminal();

  surface.beginShell("Momo");
  reviewTerminal.writeDataBlock?.("Opaque prompt", "plain", {
    kind: "review-card",
    title: "card"
  });
  surface.close();

  const output = terminal.rawWrites.join("");
  assert.ok(output.includes("\u001b[36mOpaque prompt\u001b[0m"));
});
