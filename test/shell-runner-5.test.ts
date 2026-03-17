import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ShellRunner } from "../src/cli/shell-runner";
import { openDatabase } from "../src/storage/sqlite/database";

function tempDbPath(name: string): string {
  return path.join(os.tmpdir(), `pawmemo-${name}-${Date.now()}-${Math.random()}.db`);
}

class FakeShellTerminal {
  readonly writes: string[] = [];

  constructor(private readonly inputs: string[]) {}

  write(text: string): void {
    this.writes.push(text);
  }

  async prompt(promptText: string): Promise<string> {
    this.writes.push(promptText);
    return this.inputs.shift() ?? "/quit";
  }

  close(): void {}
}

test("ShellRunner supports interactive /packs switching", async () => {
  const dbPath = tempDbPath("shell-pack-picker");
  const db = openDatabase(dbPath);

  try {
    const terminal = new FakeShellTerminal([
      "/packs",
      "tsundere",
      "/quit"
    ]);

    const runner = new ShellRunner({
      db,
      terminal
    });

    await runner.run();

    const settings = db
      .prepare(
        `
          SELECT key, value
          FROM app_settings
          WHERE key = 'companion.pack_id'
        `
      )
      .all() as Array<{ key: string; value: string }>;

    assert.deepEqual(settings, [
      { key: "companion.pack_id", value: "tsundere" }
    ]);
    assert.ok(
      terminal.writes.some((line) => line.includes("Pick a companion pack")),
      "expected /packs to ask for a pack"
    );
    assert.ok(
      terminal.writes.some((line) => line.includes("Pack switched to: tsundere")),
      "expected /packs to confirm the interactive switch"
    );
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});
