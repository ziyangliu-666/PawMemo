import test from "node:test";
import assert from "node:assert/strict";

import { loadCompanionPack } from "../src/companion/packs";
import { LlmShellCompanionVoiceWriter } from "../src/cli/shell-companion-voice";
import type { LlmTextRequest, LlmTextResponse, LlmProvider } from "../src/llm/types";

class FakeVoiceProvider implements LlmProvider {
  readonly name = "gemini" as const;
  lastRequest: LlmTextRequest | null = null;

  async generateText(request: LlmTextRequest): Promise<LlmTextResponse> {
    this.lastRequest = request;

    return {
      text: JSON.stringify({
        status_snapshot: "I kept the desk warm for us.",
        idle_prompt: 'Give me one honest word, and I will keep it close to {{recentWord}}.',
        stats_summary:
          "You moved {{todayReviewedCount}} today, and {{stableCount}} of them finally feel settled.",
        review_session_empty: "Nothing is due, so breathe for a second.",
        rescue_complete: "I saved {{notAllowed}} for later."
      })
    };
  }

  async listModels() {
    return [];
  }
}

test("LlmShellCompanionVoiceWriter parses a bounded dynamic voice bank", async () => {
  const provider = new FakeVoiceProvider();
  const writer = new LlmShellCompanionVoiceWriter(
    {
      getCurrentLlmSettings() {
        return {
          provider: "gemini",
          model: "gemini-2.5-flash",
          apiKey: "test-key",
          apiUrl: null
        };
      }
    },
    () => provider
  );

  const bank = await writer.generate({
    activePack: loadCompanionPack("girlfriend"),
    statusSignals: {
      dueCount: 2,
      recentWord: "lucid"
    },
    homeProjection: {
      generatedAt: "2026-03-15T00:00:00.000Z",
      dueCount: 2,
      recentWord: "lucid",
      entryKind: "return_review",
      focusWord: "lucid",
      focusReason: "recent",
      hasPriorReviewHistory: true,
      isReturnAfterGap: true,
      rescueCandidate: null,
      suggestedNextAction: "review",
      canStopAfterPrimaryAction: true,
      returnGapDays: 3,
      optionalNextAction: "capture"
    },
    recentTurns: ["user/reply: 你好，今天先做什么？"]
  });

  assert.equal(bank.status_snapshot, "I kept the desk warm for us.");
  assert.match(bank.idle_prompt ?? "", /{{recentWord}}/);
  assert.match(bank.stats_summary ?? "", /{{todayReviewedCount}}/);
  assert.equal(bank.review_session_empty, "Nothing is due, so breathe for a second.");
  assert.equal(bank.rescue_complete, undefined);
  assert.match(provider.lastRequest?.systemInstruction ?? "", /voice-bank templates/i);
});
