import type {
  AskWordResult,
  ReviewCardDraft,
  TeachWordDraftResult
} from "../core/domain/models";
import type {
  StudyCardSection,
  StudyCellIntent
} from "./transcript-intent";

function cloneSection(section: StudyCardSection): StudyCardSection {
  return {
    role: section.role,
    text: section.text
  };
}

function draftCopy(language: "en" | "zh"): {
  eyebrow: string;
  title: string;
  recognition: string;
  cloze: string;
  confirm: string;
  meaning: string;
  prompt: string;
} {
  if (language === "zh") {
    return {
      eyebrow: "待加入卡片",
      title: "我会先按这个样子保存",
      recognition: "识义卡",
      cloze: "填空卡",
      confirm: "如果这样顺眼，就确认保存。",
      meaning: "意思",
      prompt: "试试看"
    };
  }

  return {
    eyebrow: "Draft card",
    title: "I'll save this shape if it looks right.",
    recognition: "Recognition card",
    cloze: "Cloze card",
    confirm: "Confirm if you want this exact card saved.",
    meaning: "Meaning",
    prompt: "Try"
  };
}

function askCopy(language: "en" | "zh"): {
  eyebrow: string;
  meaning: string;
  spotlight: string;
  usage: string;
  example: string;
  status: string;
  confidence: string;
  newWord: string;
} {
  if (language === "zh") {
    return {
      eyebrow: "解释卡",
      meaning: "核心意思",
      spotlight: "重点",
      usage: "语感 / 用法",
      example: "例句",
      status: "在 PawMemo 里",
      confidence: "语境把握",
      newWord: "刚加入，还很新"
    };
  }

  return {
    eyebrow: "Explain card",
    meaning: "Core meaning",
    spotlight: "Spotlight",
    usage: "Usage / feel",
    example: "Example",
    status: "In PawMemo",
    confidence: "Context confidence",
    newWord: "Still new here"
  };
}

function answerNote(draft: ReviewCardDraft, language: "en" | "zh"): string | null {
  const parts = draft.answerText.split("\n").map((part) => part.trim()).filter(Boolean);

  if (parts.length === 0) {
    return null;
  }

  if (draft.cardType === "recognition") {
    return language === "zh"
      ? `${draftCopy(language).meaning}：${parts[0]}`
      : `${draftCopy(language).meaning}: ${parts[0]}`;
  }

  return parts.join(" · ");
}

export function appendStudyCardSections(
  intent: Omit<StudyCellIntent, "view">,
  sections: StudyCardSection[]
): StudyCellIntent {
  return {
    ...intent,
    view: {
      variant: intent.kind,
      sections: sections.map(cloneSection)
    }
  };
}

export function createReviewIntroIntent(
  lines: string[],
  groupId = "review-session-intro"
): StudyCellIntent {
  const lead = lines[0]?.trim() ?? "";
  const followUps = lines.slice(1).map((line) => line.trim()).filter(Boolean);
  const sections: StudyCardSection[] = [
    { role: "eyebrow", text: "Review lap" },
    { role: "title", text: "Short lap" }
  ];

  if (lead.length > 0) {
    sections.push({ role: "prompt", text: lead });
  }

  followUps.forEach((line) => {
    sections.push({ role: "note", text: line });
  });

  return appendStudyCardSections(
    {
      kind: "review-intro",
      title: "review",
      groupId
    },
    sections
  );
}

export function createReviewSummaryIntent(
  text: string,
  title = "Checkpoint",
  groupId = "review-session-summary"
): StudyCellIntent {
  return appendStudyCardSections(
    {
      kind: "review-summary",
      title: "summary",
      groupId
    },
    [
      { role: "eyebrow", text: "Review update" },
      { role: "title", text: title },
      { role: "prompt", text }
    ]
  );
}

export function createReviewCardIntent(
  cardId: number,
  index: number,
  sections: StudyCardSection[]
): StudyCellIntent {
  return appendStudyCardSections(
    {
      kind: "review-card",
      title: "card",
      emphasis: "What we were looking for:",
      groupId: `review-card-${cardId}-${index}`
    },
    sections
  );
}

export function createTeachDraftIntent(
  draftResult: TeachWordDraftResult
): StudyCellIntent {
  const language = draftResult.draft.promptLanguage;
  const copy = draftCopy(language);
  const recognition = draftResult.draft.cards.find(
    (card) => card.cardType === "recognition"
  );
  const cloze = draftResult.draft.cards.find((card) => card.cardType === "cloze");
  const sections: StudyCardSection[] = [
    { role: "eyebrow", text: copy.eyebrow },
    { role: "title", text: draftResult.draft.word },
    { role: "subtitle", text: draftResult.draft.gloss },
    { role: "note", text: copy.title }
  ];

  if (recognition) {
    sections.push({ role: "eyebrow", text: copy.recognition });
    sections.push({ role: "prompt", text: recognition.promptText });
    const recognitionAnswer = answerNote(recognition, language);
    if (recognitionAnswer) {
      sections.push({ role: "eyebrow", text: copy.meaning });
      sections.push({ role: "answer", text: recognitionAnswer });
    }
  }

  if (cloze) {
    sections.push({ role: "eyebrow", text: copy.cloze });
    sections.push({ role: "prompt", text: cloze.promptText });
    const clozeAnswer = answerNote(cloze, language);
    if (clozeAnswer) {
      sections.push({ role: "eyebrow", text: copy.meaning });
      sections.push({ role: "answer", text: clozeAnswer });
    }
  }

  sections.push({ role: "note", text: copy.confirm });

  return appendStudyCardSections(
    {
      kind: "teach-draft",
      title: "draft",
      groupId: `teach-draft-${draftResult.ask.normalized}`
    },
    sections
  );
}

export function createAskResultIntent(
  result: AskWordResult
): StudyCellIntent {
  const copy = askCopy(result.responseLanguage);
  const sections: StudyCardSection[] = [
    { role: "eyebrow", text: copy.eyebrow },
    { role: "title", text: result.word },
    { role: "eyebrow", text: copy.meaning },
    { role: "answer", text: result.gloss },
    { role: "prompt", text: result.explanation }
  ];

  if (result.highlights.length > 0) {
    sections.push({ role: "eyebrow", text: copy.spotlight });
    sections.push({ role: "answer", text: result.highlights.join(" · ") });
  }

  sections.push({ role: "eyebrow", text: copy.usage });
  sections.push({ role: "prompt", text: result.usageNote });

  if (result.example.trim().length > 0 && result.example !== "No example available.") {
    sections.push({ role: "eyebrow", text: copy.example });
    sections.push({ role: "prompt", text: result.example });
  }

  sections.push({
    role: "meta",
    text:
      result.knownState !== null
        ? `${copy.status}: ${result.knownState}`
        : `${copy.status}: ${copy.newWord}`
  });
  sections.push({
    role: "note",
    text: `${copy.confidence}: ${result.confidenceNote}`
  });

  return appendStudyCardSections(
    {
      kind: "ask-result",
      title: "ask",
      groupId: `ask-result-${result.normalized}`
    },
    sections
  );
}

export function flattenStudyCardIntent(
  intent: StudyCellIntent
): string {
  const sections = intent.view?.sections ?? [];

  if (sections.length === 0) {
    return "";
  }

  const lines: string[] = [];
  let pendingLabel: string | null = null;

  const pushBlock = (text: string, indent = ""): void => {
    text
      .split("\n")
      .forEach((line, index) => {
        lines.push(index === 0 ? `${indent}${line}` : `${indent}${line}`);
      });
  };

  sections.forEach((section, index) => {
    const nextRole = sections[index + 1]?.role;

    switch (section.role) {
      case "eyebrow":
        if (pendingLabel) {
          lines.push(pendingLabel.toUpperCase());
          lines.push("");
        }
        pendingLabel = section.text;
        if (nextRole === "title" || nextRole === "subtitle" || nextRole === "eyebrow") {
          lines.push(section.text.toUpperCase());
          lines.push("");
          pendingLabel = null;
        }
        break;
      case "title":
        if (pendingLabel) {
          lines.push(pendingLabel.toUpperCase());
          lines.push("");
          pendingLabel = null;
        }
        lines.push(section.text);
        if (nextRole !== "subtitle") {
          lines.push("-".repeat(Math.max(4, Math.min(20, section.text.length))));
        }
        break;
      case "subtitle":
        lines.push(section.text);
        lines.push("-".repeat(Math.max(4, Math.min(20, section.text.length))));
        break;
      case "prompt":
      case "answer":
      case "note":
      case "meta": {
        const block = section.text.trim();
        if (block.length === 0) {
          pendingLabel = null;
          break;
        }

        if (pendingLabel) {
          const [firstLine, ...rest] = block.split("\n");
          lines.push(`${pendingLabel}: ${firstLine}`);
          rest.forEach((line) => lines.push(`  ${line}`));
          pendingLabel = null;
        } else {
          pushBlock(block);
        }

        if (section.role !== "note" && section.role !== "meta") {
          lines.push("");
        }
        break;
      }
    }
  });

  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  return lines.join("\n");
}

export function createTeachDraftConfirmationMessage(
  draftResult: TeachWordDraftResult
): string {
  return draftResult.draft.promptLanguage === "zh"
    ? `我先把 “${draftResult.ask.word}” 起草成一张卡了。要按这个加入吗？`
    : `I drafted a card for "${draftResult.ask.word}" first. Do you want me to save it as shown?`;
}

export function createTeachDraftCancelMessage(
  draftResult: TeachWordDraftResult
): string {
  return draftResult.draft.promptLanguage === "zh"
    ? `好，那我先不把 “${draftResult.ask.word}” 加进去。`
    : `Okay. I won't save "${draftResult.ask.word}" right now.`;
}

export function createReviewCardBodySections(
  heading: string,
  lemma: string,
  cardType: ReviewCardDraft["cardType"],
  promptText: string,
  answerText?: string
): StudyCardSection[] {
  const cue = heading.split(":", 1)[0]?.trim() || "Review card";
  const typeLabel = cardType === "cloze" ? "Cloze card" : "Recognition card";
  const sections: StudyCardSection[] = [
    { role: "eyebrow", text: cue },
    { role: "title", text: lemma },
    { role: "subtitle", text: typeLabel },
    { role: "eyebrow", text: "Try" },
    { role: "prompt", text: promptText }
  ];

  if (answerText) {
    sections.push({ role: "eyebrow", text: "Answer" });
    sections.push({ role: "answer", text: answerText });
  }

  return sections;
}

export function createReviewMetadataSection(
  label: string
): StudyCardSection {
  return {
    role: "note",
    text: label
  };
}

export function createReviewResultSection(
  text: string
): StudyCardSection {
  return {
    role: "prompt",
    text
  };
}
