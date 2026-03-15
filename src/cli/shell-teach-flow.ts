import type {
  TeachWordDraftOutcome,
  TeachWordDraftResult,
  TeachWordInput
} from "../core/domain/models";
import { detectCardPromptLanguage } from "../review/card-language";
import type { PromptSelectionRequest } from "./review-session-runner";
import type {
  ShellAgentDecision,
  ShellAgentResponse
} from "./shell-contract";
import {
  createTeachDraftCancelMessage,
  createTeachDraftConfirmationMessage
} from "./study-card-view";

export class ShellTeachFlowCoordinator {
  buildDraftSelectionRequest(
    draft: TeachWordDraftResult
  ): PromptSelectionRequest {
    const language = draft.draft.promptLanguage;
    const cardCount = draft.draft.cards.length;

    if (language === "zh") {
      return {
        promptText: `要按这个保存 “${draft.ask.word}” 吗？`,
        initialValue: "confirm",
        choices: [
          {
            value: "confirm",
            label: `加入这 ${cardCount} 张卡`,
            aliases: ["1", "y", "yes", "s"],
            description: "按这个草稿写入学习计划"
          },
          {
            value: "cancel",
            label: "先不保存",
            aliases: ["2", "n", "no", "q"],
            description: "先留在预览，不写入"
          }
        ]
      };
    }

    return {
      promptText: `Save this draft for "${draft.ask.word}"?`,
      initialValue: "confirm",
      choices: [
        {
          value: "confirm",
          label: `Save ${cardCount} card${cardCount === 1 ? "" : "s"}`,
          aliases: ["1", "y", "yes", "s"],
          description: "Persist this exact draft into the study plan"
        },
        {
          value: "cancel",
          label: "Not now",
          aliases: ["2", "n", "no", "q"],
          description: "Leave it as a preview without saving"
        }
      ]
    };
  }

  prepareDecision(
    input: TeachWordInput,
    outcome: TeachWordDraftOutcome,
    source: ShellAgentResponse["source"]
  ): ShellAgentDecision {
    if (outcome.status === "ready") {
      return this.buildDraftDecision(input, outcome, source);
    }

    return {
      response: {
        kind: "execute",
        action: {
          kind: "teach-clarify-context",
          input
        },
        source
      },
      nextPendingProposal: null
    };
  }

  buildClarificationRequest(
    input: TeachWordInput
  ): PromptSelectionRequest {
    const promptLanguage = detectCardPromptLanguage(input.context);

    return {
      promptText:
        promptLanguage === "zh"
          ? `怎么继续处理 “${input.word}”？`
          : `How should I continue with "${input.word}"?`,
      initialValue: "definition",
      choices: promptLanguage === "zh"
        ? [
            {
              value: "definition",
              label: "定义卡",
              aliases: ["1", "d"],
              description: "直接按词义起草一张卡"
            },
            {
              value: "example",
              label: "给例句",
              aliases: ["2", "e"],
              description: "我再给你一句包含这个词的句子"
            },
            {
              value: "explain",
              label: "只解释",
              aliases: ["3", "a"],
              description: "先解释这个词，不保存"
            }
          ]
        : [
            {
              value: "definition",
              label: "Definition card",
              aliases: ["1", "d"],
              description: "Draft a simple card from the gloss now"
            },
            {
              value: "example",
              label: "Give example",
              aliases: ["2", "e"],
              description: "I will give you a sentence with the word in it"
            },
            {
              value: "explain",
              label: "Explain only",
              aliases: ["3", "a"],
              description: "Explain it without saving"
            }
          ]
    };
  }

  createClarificationMessage(input: TeachWordInput): string {
    const promptLanguage = detectCardPromptLanguage(input.context);
    return promptLanguage === "zh"
      ? `我知道你想学 “${input.word}”，但这句话还不够拿来做例句卡。你想怎么继续？`
      : `I can tell you want to learn "${input.word}", but that still is not a usable example sentence for a review card. How do you want to continue?`;
  }

  createExampleRequestMessage(input: TeachWordInput): string {
    const promptLanguage = detectCardPromptLanguage(input.context);
    return promptLanguage === "zh"
      ? `发我一句带 “${input.word}” 的例句，我就按例句起草。`
      : `Send me one sentence with "${input.word}" in it and I'll draft the card from that.`;
  }

  createExamplePromptLabel(input: TeachWordInput): string {
    return detectCardPromptLanguage(input.context) === "zh" ? "例句: " : "Example: ";
  }

  createExampleMissingMessage(input: TeachWordInput): string {
    const promptLanguage = detectCardPromptLanguage(input.context);
    return promptLanguage === "zh"
      ? `我还没有拿到例句，所以先不保存 “${input.word}”。`
      : `I still do not have an example sentence, so I did not save "${input.word}".`;
  }

  private buildDraftDecision(
    input: TeachWordInput,
    teachDraft: TeachWordDraftResult,
    source: ShellAgentResponse["source"]
  ): ShellAgentDecision {
    return {
      response: {
        kind: "message",
        mood: "curious",
        text: createTeachDraftConfirmationMessage(teachDraft),
        source
      },
      nextPendingProposal: {
        action: {
          kind: "teach-confirm",
          input,
          draft: teachDraft
        },
        confirmationMessage: createTeachDraftConfirmationMessage(teachDraft),
        cancelMessage: createTeachDraftCancelMessage(teachDraft),
        teachDraft
      }
    };
  }
}
