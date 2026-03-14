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
  private viewport = {
    columns: 80,
    rows: 24
  };

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

  getViewportSize(): { columns: number; rows: number } {
    return { ...this.viewport };
  }
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

test("LineShellSurface keeps ordinary assistant body text white when color is enabled", () => {
  const terminal = new FakeShellTerminal([], true);
  const surface = new LineShellSurface(terminal);

  surface.writeAssistantReplyNow("Hello from Momo");

  assert.deepEqual(terminal.rawWrites, []);
  assert.equal(
    terminal.writes[0],
    "\u001b[97m• \u001b[0m\u001b[97mHello from Momo\u001b[0m"
  );
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

test("LineShellSurface flattens structured study cards into labeled blocks instead of raw prose dumps", () => {
  const terminal = new FakeShellTerminal([], true);
  const surface = new LineShellSurface(terminal);

  surface.writeDataBlock("opaque", "plain", {
    kind: "review-card",
    title: "card",
    groupId: "review-card-1",
    view: {
      variant: "review-card",
      sections: [
        { role: "eyebrow", text: "First up" },
        { role: "title", text: "facilitator" },
        { role: "subtitle", text: "Cloze card" },
        { role: "eyebrow", text: "Try" },
        { role: "prompt", text: "handle invalid ____ responses, facilitator" },
        { role: "eyebrow", text: "Answer" },
        { role: "answer", text: "What we were looking for: facilitator" }
      ]
    }
  });

  const output = terminal.writes[0] ?? "";
  assert.match(output, /FIRST UP/);
  assert.match(output, /facilitator/);
  assert.match(output, /Cloze card/);
  assert.match(output, /Try:/);
  assert.match(output, /handle invalid ____ responses, facilitator/);
  assert.match(output, /Answer:/);
  assert.match(output, /What we were looking for: facilitator/);
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
  assert.match(output, /› /);
  assert.match(output, /Hello from transcript/);
  assert.ok(
    output
      .split("\u001b[")
      .some((fragment) => /^\d+;\d+H/.test(fragment))
  );
  assert.ok(output.includes("\u001b[?1049l"));
});

test("TuiShellSurface renders a landing-style empty state instead of a blank transcript", () => {
  const terminal = new FakeShellTerminal([]);
  const surface = new TuiShellSurface(terminal);

  surface.beginShell("Momo");
  surface.close();

  const output = terminal.rawWrites.join("");
  assert.match(output, /Momo's Study Nook/);
  assert.match(output, /Save one word, ask one question, and let Momo keep it warm\./);
});

test("TuiShellSurface exposes a semantic frame snapshot for tooling", () => {
  const terminal = new FakeShellTerminal([]);
  const surface = new TuiShellSurface(terminal, {
    inlineInputMode: "external"
  });

  surface.beginShell("Momo");
  surface.writeAssistantReplyNow("Hello from transcript");

  const snapshot = surface.getFrameSnapshot();

  assert.equal(snapshot.displayName, "Momo");
  assert.equal(snapshot.viewport.columns, 80);
  assert.equal(snapshot.composer.promptLabel, "› ");
  assert.equal(snapshot.transcript.committedCells[0]?.kind, "assistant");
  assert.equal(snapshot.transcript.committedCells[0]?.text, "Hello from transcript");
  assert.match(snapshot.rendered.frameText, /Hello from transcript/);
  assert.ok(snapshot.layout.transcript.height >= 1);

  surface.close();
});

test("TuiShellSurface can accept external composer input events", async () => {
  const terminal = new FakeShellTerminal([]);
  const surface = new TuiShellSurface(terminal, {
    inputMode: "external-composer"
  });

  surface.beginShell("Momo");
  const promptPromise = surface.prompt();

  surface.applyExternalInput({ kind: "text", text: "/he" });
  let snapshot = surface.getFrameSnapshot();
  assert.equal(snapshot.composer.buffer, "/he");
  assert.ok(snapshot.composer.slashSuggestions.some((entry) => entry.command === "/help"));

  surface.applyExternalInput({ kind: "key", key: "tab" });
  snapshot = surface.getFrameSnapshot();
  assert.equal(snapshot.composer.buffer, "/help ");

  surface.applyExternalInput({ kind: "key", key: "submit" });
  const submitted = await promptPromise;
  snapshot = surface.getFrameSnapshot();

  assert.equal(submitted, "/help ");
  assert.equal(snapshot.transcript.committedCells[0]?.kind, "user-line");
  assert.equal(snapshot.transcript.committedCells[0]?.text, "/help ");

  surface.close();
});

test("TuiShellSurface keeps the empty-state landing hero minimal even when due count changes", () => {
  const terminal = new FakeShellTerminal([]);
  const surface = new TuiShellSurface(terminal);

  surface.beginShell("Momo");
  surface.setMode("Chat", 3);
  surface.close();

  const output = terminal.rawWrites.join("");
  assert.match(output, /3 due/);
  assert.match(output, /Save one word, ask one question, and let Momo keep it warm\./);
  assert.doesNotMatch(output, /Start Here|Grow Momo's Den|Primary: \/rescue/);
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

test("TuiShellSurface renders a moving highlighted segment inside waiting text when color is enabled", () => {
  const terminal = new FakeShellTerminal([], true);
  const surface = new TuiShellSurface(terminal);

  surface.beginShell("Momo");
  surface.showWaitingIndicator("Momo", "Lining up the next step.");
  surface.close();

  const output = terminal.rawWrites.join("");
  assert.match(output, /Lining/);
  assert.match(output, /up the next step\./);
  assert.ok(output.includes("\u001b[1;97m"));
});

test("TuiShellSurface can sweep the waiting highlight into later words", () => {
  const terminal = new FakeShellTerminal([], true);
  const surface = new TuiShellSurface(terminal);

  surface.beginShell("Momo");
  surface.showWaitingIndicator("Momo", "Give me a beat. I'm lining up the next paw-step.");

  const debugSurface = surface as unknown as {
    waitingHighlightStep: number;
    renderStatusLine: (columns: number) => string[];
  };

  debugSurface.waitingHighlightStep = 20;
  const statusLines = debugSurface.renderStatusLine(120);
  surface.close();

  assert.equal(statusLines.length, 1);
  assert.match(statusLines[0] ?? "", /lining/i);
  assert.ok((statusLines[0] ?? "").includes("\u001b[1;97m"));
});

test("TuiShellSurface can size the waiting highlight from an explicit percent and total chars", () => {
  const terminal = new FakeShellTerminal([], true);
  const surface = new TuiShellSurface(terminal);

  surface.beginShell("Momo");
  surface.setStreamHighlight?.({
    percent: 40,
    totalChars: 10
  });
  surface.showWaitingIndicator("Momo", "abcdefghij");
  surface.close();

  const output = terminal.rawWrites.join("");
  assert.ok(output.includes("\u001b[1;97mabcd\u001b[0m"));
});

test("TuiShellSurface highlights the newest configured segment while assistant text is still streaming", () => {
  const terminal = new FakeShellTerminal([], true);
  const surface = new TuiShellSurface(terminal);

  surface.beginShell("Momo");
  surface.setStreamHighlight?.({
    percent: 40,
    totalChars: 10
  });
  surface.beginAssistantReplyStream();
  surface.appendAssistantReplyDelta("abcdefghij");
  surface.close();

  const output = terminal.rawWrites.join("");
  assert.ok(output.includes("\u001b[97m• \u001b[0m\u001b[97mabcdef\u001b[0m\u001b[96mghij\u001b[0m"));
});

test("TuiShellSurface renders committed assistant text with a white body", () => {
  const terminal = new FakeShellTerminal([], true);
  const surface = new TuiShellSurface(terminal);

  surface.beginShell("Momo");
  surface.writeAssistantReplyNow("Hello from transcript");
  surface.close();

  const output = terminal.rawWrites.join("");
  assert.ok(output.includes("\u001b[97m• \u001b[0m\u001b[97mHello from transcript\u001b[0m"));
});

test("TuiShellSurface styles study-card key lines light blue while keeping body copy white", () => {
  const terminal = new FakeShellTerminal([], true);
  const surface = new TuiShellSurface(terminal);

  surface.beginShell("Momo");
  surface.writeDataBlock("Draft card\nRecognition\nWhat does \"luminous\" mean?", "plain", {
    kind: "teach-draft",
    title: "draft",
    groupId: "teach-draft-luminous",
    view: {
      variant: "teach-draft",
      sections: [
        { role: "eyebrow", text: "Draft card" },
        { role: "title", text: "luminous" },
        { role: "subtitle", text: "emitting light" },
        { role: "note", text: "I'll save this shape if it looks right." },
        { role: "eyebrow", text: "Recognition card" },
        { role: "prompt", text: "Default body copy stays plain and readable." },
        { role: "eyebrow", text: "Meaning" },
        { role: "answer", text: "Meaning: emitting light" }
      ]
    }
  });
  surface.close();

  const output = terminal.rawWrites.join("");
  assert.ok(output.includes("\u001b[90m◆ DRAFT CARD\u001b[0m"));
  assert.match(output, /luminous/);
  assert.ok(output.includes("\u001b[97m  Default body copy stays plain and readable.\u001b[0m"));
  assert.ok(output.includes("\u001b[1;36m  Meaning: emitting light\u001b[0m"));
});

test("TuiShellSurface separates ask-card title and sections instead of flattening them together", () => {
  const terminal = new FakeShellTerminal([], true);
  const surface = new TuiShellSurface(terminal);

  surface.beginShell("Momo");
  surface.writeDataBlock("Explain card\nslay", "plain", {
    kind: "ask-result",
    title: "ask",
    groupId: "ask-result-slay",
    view: {
      variant: "ask-result",
      sections: [
        { role: "eyebrow", text: "Explain card" },
        { role: "title", text: "slay" },
        { role: "eyebrow", text: "Core meaning" },
        { role: "answer", text: "do extremely well" },
        { role: "prompt", text: "Used to praise someone for doing something impressively well." },
        { role: "eyebrow", text: "Example" },
        { role: "prompt", text: "She absolutely slayed that performance." }
      ]
    }
  });
  surface.close();

  const output = terminal.rawWrites.join("");
  assert.match(output, /◆ EXPLAIN CARD/);
  assert.match(output, /slay/);
  assert.match(output, /─{6,}/);
  assert.match(output, /◆ CORE MEANING/);
  assert.match(output, /◆ EXAMPLE/);
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
  assert.match(output, /Opaque prompt/);
  assert.ok(output.includes("\u001b[48;5;236m"));
});

test("TuiShellSurface renders teach drafts through the same centered study-card surface", () => {
  const terminal = new FakeShellTerminal([], true);
  const surface = new TuiShellSurface(terminal);

  surface.beginShell("Momo");
  surface.writeDataBlock("Draft card\nRecognition\nWhat does \"luminous\" mean?", "plain", {
    kind: "teach-draft",
    title: "draft",
    groupId: "teach-draft-luminous",
    view: {
      variant: "teach-draft",
      sections: [
        { role: "eyebrow", text: "Draft card" },
        { role: "title", text: "luminous" },
        { role: "subtitle", text: "emitting light" },
        { role: "note", text: "I'll save this shape if it looks right." },
        { role: "eyebrow", text: "Recognition card" },
        { role: "prompt", text: 'What does "luminous" mean in this context?' },
        { role: "eyebrow", text: "Meaning" },
        { role: "answer", text: "Meaning: emitting light" }
      ]
    }
  });
  surface.close();

  const output = terminal.rawWrites.join("");
  assert.match(output, /◆ DRAFT CARD/);
  assert.match(output, /luminous/);
  assert.match(output, /emitting light/);
  assert.match(output, /I'll save this shape if it looks right\./);
  assert.match(output, /─{6,}/);
  assert.match(output, /◆ RECOGNITION CARD/);
  assert.match(output, /What does "luminous" mean in this context\?/);
  assert.match(output, /◆ MEANING/);
  assert.match(output, /Meaning: emitting light/);
  assert.ok(output.includes("\u001b[48;5;236m"));
});

test("TuiShellSurface gives review cards a cue label, centered word title, and prompt-answer sections", () => {
  const terminal = new FakeShellTerminal([], true);
  const surface = new TuiShellSurface(terminal);
  const reviewTerminal = surface.createReviewSessionTerminal();

  surface.beginShell("Momo");
  reviewTerminal.writeDataBlock?.("First up: facilitator", "review-card-heading", {
    kind: "review-card",
    title: "card",
    emphasis: "What we were looking for:",
    groupId: "review-card-1"
  });
  reviewTerminal.writeDataBlock?.(
    "handle invalid ____ responses, facilitator",
    "plain",
    {
      kind: "review-card",
      title: "card",
      emphasis: "What we were looking for:",
      groupId: "review-card-1",
      view: {
        variant: "review-card",
        sections: [
          { role: "eyebrow", text: "First up" },
          { role: "title", text: "facilitator" },
          { role: "subtitle", text: "Cloze card" },
          { role: "eyebrow", text: "Try" },
          { role: "prompt", text: "handle invalid ____ responses, facilitator" },
          { role: "eyebrow", text: "Answer" },
          { role: "answer", text: "What we were looking for: facilitator" }
        ]
      }
    }
  );
  surface.close();

  const output = terminal.rawWrites.join("");
  assert.match(output, /◆ FIRST UP/);
  assert.match(output, /facilitator/);
  assert.match(output, /Cloze card/);
  assert.match(output, /◆ TRY/);
  assert.match(output, /handle invalid ____ responses, facilitator/);
  assert.match(output, /◆ ANSWER/);
  assert.match(output, /What we were looking for: facilitator/);
});

test("TuiShellSurface supports tab-and-enter review selections", async () => {
  const terminal = new FakeShellTerminal([], true);
  const surface = new TuiShellSurface(terminal);
  const reviewTerminal = surface.createReviewSessionTerminal();

  (surface as unknown as { canUseInlineComposer: () => boolean }).canUseInlineComposer =
    () => true;

  surface.beginShell("Momo");
  const selectionPromise = reviewTerminal.select?.({
    promptText: "How did that feel?",
    initialValue: "good",
    choices: [
      { value: "again", label: "Again", aliases: ["a"] },
      { value: "hard", label: "Hard", aliases: ["h"] },
      { value: "good", label: "Good", aliases: ["g"] },
      { value: "easy", label: "Easy", aliases: ["e"] },
      { value: "quit", label: "Pause", aliases: ["q"] }
    ]
  });

  assert.ok(selectionPromise);

  (surface as unknown as { onGlobalData: (chunk: string) => void }).onGlobalData("\t");
  (surface as unknown as { onGlobalData: (chunk: string) => void }).onGlobalData("\r");

  const selection = await selectionPromise;
  surface.close();

  assert.equal(selection, "easy");
  const output = terminal.rawWrites.join("");
  assert.match(output, /How did that feel\?/);
  assert.match(output, /Tab\/↑\/↓ choose/);
  assert.match(output, /\(A\) Again/);
  assert.match(output, /\(G\) Good/);
  assert.match(output, /› .*?\(E\) Easy/);
});

test("TuiShellSurface merges one review card history into one centered study card", () => {
  const terminal = new FakeShellTerminal([], true);
  const surface = new TuiShellSurface(terminal);
  const reviewTerminal = surface.createReviewSessionTerminal();

  surface.beginShell("Momo");
  reviewTerminal.writeDataBlock?.("First up: facilitator", "review-card-heading", {
    kind: "review-card",
    title: "card",
    emphasis: "What we were looking for:",
    groupId: "card-1"
  });
  reviewTerminal.writeDataBlock?.(
    "handle invalid ____ responses, facilitator",
    "plain",
    {
      kind: "review-card",
      title: "card",
      emphasis: "What we were looking for:",
      groupId: "card-1"
    }
  );
  reviewTerminal.writeDataBlock?.(
    "What we were looking for: facilitator",
    "review-card-field",
    {
      kind: "review-card",
      title: "card",
      emphasis: "What we were looking for:",
      groupId: "card-1"
    }
  );
  surface.close();

  const output = terminal.rawWrites.join("");
  assert.match(output, /First up: facilitator/);
  assert.match(output, /handle invalid ____ responses, facilitator/);
  assert.match(output, /What we were looking for: facilitator/);
  assert.ok(output.includes("\u001b[48;5;236m"));
});

test("TuiShellSurface wraps assistant lines within the available width including the bullet prefix", () => {
  const terminal = new FakeShellTerminal([], false);
  const originalColumns = process.stdout.columns;
  const originalRows = process.stdout.rows;

  Object.defineProperty(process.stdout, "columns", {
    configurable: true,
    value: 40
  });
  Object.defineProperty(process.stdout, "rows", {
    configurable: true,
    value: 12
  });

  try {
    const surface = new TuiShellSurface(terminal);
    surface.beginShell("Momo");
    surface.writeAssistantReplyNow(
      'Here "Spire" means "A tall, pointed structure atop a building".'
    );
    surface.close();

    const frames = terminal.rawWrites.join("");
    assert.doesNotMatch(frames, /building"\.\r?\n\./);
    assert.doesNotMatch(frames, /tha\r?\nt/);
  } finally {
    Object.defineProperty(process.stdout, "columns", {
      configurable: true,
      value: originalColumns
    });
    Object.defineProperty(process.stdout, "rows", {
      configurable: true,
      value: originalRows
    });
  }
});

test("TuiShellSurface prefers breaking assistant prose at word boundaries", () => {
  const terminal = new FakeShellTerminal([], false);
  const surface = new TuiShellSurface(terminal);
  const renderCellLines = (
    surface as unknown as {
      renderCellLines: (
        entry: { id: number; kind: "assistant"; text: string },
        columns: number
      ) => string[];
    }
  ).renderCellLines.bind(surface);

  const lines = renderCellLines(
    {
      id: 1,
      kind: "assistant",
      text: "alpha beta gamma delta"
    },
    12
  );

  assert.deepEqual(lines, ["• alpha beta", "  gamma", "  delta"]);
});

test("TuiShellSurface accepts Chinese text through the inline composer", async () => {
  const terminal = new FakeShellTerminal([], true);
  const surface = new TuiShellSurface(terminal);

  (surface as unknown as { canUseInlineComposer: () => boolean }).canUseInlineComposer =
    () => true;

  surface.beginShell("Momo");
  const promptPromise = surface.prompt();

  (surface as unknown as { onGlobalData: (chunk: string) => void }).onGlobalData(
    "记住 luminous = 发光的"
  );
  (surface as unknown as { onGlobalData: (chunk: string) => void }).onGlobalData("\r");

  const submitted = await promptPromise;
  surface.close();

  assert.equal(submitted, "记住 luminous = 发光的");
});

test("TuiShellSurface treats bracketed paste as paste instead of premature submit", async () => {
  const terminal = new FakeShellTerminal([], true);
  const surface = new TuiShellSurface(terminal);
  let resolved = false;

  (surface as unknown as { canUseInlineComposer: () => boolean }).canUseInlineComposer =
    () => true;

  surface.beginShell("Momo");
  const promptPromise = surface.prompt().then((value) => {
    resolved = true;
    return value;
  });

  (surface as unknown as { onGlobalData: (chunk: string) => void }).onGlobalData(
    "\u001b[200~第一行\n第二行\u001b[201~"
  );

  await Promise.resolve();
  assert.equal(resolved, false);

  (surface as unknown as { onGlobalData: (chunk: string) => void }).onGlobalData("\r");

  const submitted = await promptPromise;
  surface.close();

  assert.equal(submitted, "第一行\n第二行");
});

test("TuiShellSurface moves and deletes by grapheme cluster in the inline composer", async () => {
  const terminal = new FakeShellTerminal([], true);
  const surface = new TuiShellSurface(terminal);

  (surface as unknown as { canUseInlineComposer: () => boolean }).canUseInlineComposer =
    () => true;

  surface.beginShell("Momo");
  const promptPromise = surface.prompt();

  (surface as unknown as { onGlobalData: (chunk: string) => void }).onGlobalData("A👍🏽B");
  (surface as unknown as { onGlobalData: (chunk: string) => void }).onGlobalData("\u001b[D");
  (surface as unknown as { onGlobalData: (chunk: string) => void }).onGlobalData("\u007f");
  (surface as unknown as { onGlobalData: (chunk: string) => void }).onGlobalData("\r");

  const submitted = await promptPromise;
  surface.close();

  assert.equal(submitted, "AB");
});

test("TuiShellSurface accepts repeated CRLF submits across consecutive prompts", async () => {
  const terminal = new FakeShellTerminal([], true);
  const surface = new TuiShellSurface(terminal);

  (surface as unknown as { canUseInlineComposer: () => boolean }).canUseInlineComposer =
    () => true;

  surface.beginShell("Momo");

  const firstPrompt = surface.prompt();
  (surface as unknown as { onGlobalData: (chunk: string) => void }).onGlobalData("第一次\r\n");
  const firstSubmitted = await firstPrompt;

  const secondPrompt = surface.prompt();
  (surface as unknown as { onGlobalData: (chunk: string) => void }).onGlobalData("第二次\r\n");
  const secondSubmitted = await secondPrompt;

  surface.close();

  assert.equal(firstSubmitted, "第一次");
  assert.equal(secondSubmitted, "第二次");
});

test("TuiShellSurface replays a submit that lands before the next prompt is armed", async () => {
  const terminal = new FakeShellTerminal([], true);
  const surface = new TuiShellSurface(terminal);

  (surface as unknown as { canUseInlineComposer: () => boolean }).canUseInlineComposer =
    () => true;

  surface.beginShell("Momo");

  const firstPrompt = surface.prompt();
  (surface as unknown as { onGlobalData: (chunk: string) => void }).onGlobalData("第一段\r");
  const firstSubmitted = await firstPrompt;

  (surface as unknown as { onGlobalData: (chunk: string) => void }).onGlobalData("第二段");
  (surface as unknown as { onGlobalData: (chunk: string) => void }).onGlobalData("\r");

  const secondSubmitted = await surface.prompt();
  surface.close();

  assert.equal(firstSubmitted, "第一段");
  assert.equal(secondSubmitted, "第二段");
});

test("TuiShellSurface debug mode logs deferred submits inside the transcript", async () => {
  const terminal = new FakeShellTerminal([], true);
  const surface = new TuiShellSurface(terminal, { debug: true });

  (surface as unknown as { canUseInlineComposer: () => boolean }).canUseInlineComposer =
    () => true;

  surface.beginShell("Momo");
  const firstPrompt = surface.prompt();
  (surface as unknown as { onGlobalData: (chunk: string) => void }).onGlobalData("先发出去\r");
  await firstPrompt;

  (surface as unknown as { onGlobalData: (chunk: string) => void }).onGlobalData("第二段");
  (surface as unknown as { onGlobalData: (chunk: string) => void }).onGlobalData("\r");
  await surface.prompt();
  surface.close();

  const output = terminal.rawWrites.join("");
  assert.match(output, /Input Debug: submit-deferred/);
  assert.match(output, /Input Debug: deferred-submit-replayed/);
});

test("TuiShellSurface shows an exit confirmation hint on the first Ctrl+C", () => {
  const terminal = new FakeShellTerminal([], true);
  const surface = new TuiShellSurface(terminal);

  surface.beginShell("Momo");
  (surface as unknown as { onGlobalData: (chunk: string) => void }).onGlobalData("\u0003");

  const debugSurface = surface as unknown as {
    renderFooter: (columns: number) => string[];
  };

  const footerLines = debugSurface.renderFooter(120);
  surface.close();

  assert.equal(footerLines.length, 1);
  assert.match(footerLines[0] ?? "", /Press Ctrl\+C again to exit/i);
});

test("TuiShellSurface clears the exit confirmation hint after any other input", async () => {
  const terminal = new FakeShellTerminal([], true);
  const surface = new TuiShellSurface(terminal);

  surface.beginShell("Momo");
  const promptPromise = surface.prompt();
  (surface as unknown as { onGlobalData: (chunk: string) => void }).onGlobalData("\u0003");
  (surface as unknown as { onGlobalData: (chunk: string) => void }).onGlobalData("a");
  (surface as unknown as { onGlobalData: (chunk: string) => void }).onGlobalData("\r");
  await promptPromise;

  const debugSurface = surface as unknown as {
    renderFooter: (columns: number) => string[];
  };

  const footerLines = debugSurface.renderFooter(120);
  surface.close();

  assert.equal(footerLines.length, 1);
  assert.doesNotMatch(footerLines[0] ?? "", /Press Ctrl\+C again to exit/i);
});

test("TuiShellSurface exits the armed prompt on the second Ctrl+C", async () => {
  const terminal = new FakeShellTerminal([], true);
  const surface = new TuiShellSurface(terminal);

  surface.beginShell("Momo");
  const promptPromise = surface.prompt();
  (surface as unknown as { onGlobalData: (chunk: string) => void }).onGlobalData("\u0003");
  (surface as unknown as { onGlobalData: (chunk: string) => void }).onGlobalData("\u0003");
  const submitted = await promptPromise;
  surface.close();

  assert.equal(submitted, "/quit");
});

test("TuiShellSurface hides the terminal cursor while waiting and shows it again when input is armed", () => {
  const terminal = new FakeShellTerminal([], true);
  const surface = new TuiShellSurface(terminal);

  surface.beginShell("Momo");
  surface.showWaitingIndicator("Momo", "Hold on. I'm brushing the answer clean.");
  const waitingFrame = terminal.rawWrites.at(-1) ?? "";

  void surface.prompt();
  const promptFrame = terminal.rawWrites.at(-1) ?? "";
  surface.close();

  assert.ok(waitingFrame.includes("\u001b[?25l"));
  assert.ok(promptFrame.includes("\u001b[?25h"));
});

test("TuiShellSurface renders alert lines with error styling", () => {
  const terminal = new FakeShellTerminal([], true);
  const surface = new TuiShellSurface(terminal);

  surface.beginShell("Momo");
  surface.writeAlert("Okay, I stopped there.");
  surface.close();

  const output = terminal.rawWrites.join("");
  assert.match(output, /Okay, I stopped there\./);
  assert.ok(output.includes("\u001b[1;31m"));
});
