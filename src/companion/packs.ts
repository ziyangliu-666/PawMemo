import fs from "node:fs";
import path from "node:path";

import { ConfigurationError } from "../lib/errors";
import type {
  CompanionLineTemplateSet,
  CompanionMood,
  CompanionPackDefinition,
  CompanionPackSummary,
  CompanionReactionKey,
  CompanionTemplateContext,
  RomanceMode
} from "./types";

const BUILTIN_PACKS: Record<string, CompanionPackDefinition> = {
  momo: {
    id: "momo",
    displayName: "Momo",
    archetype: "loyal-dog",
    styleLabel: "loyal",
    romanceMode: "off",
    avatarFrames: {
      idle: ["U•ᴥ•U", "UᵔᴥᵔU", "U˘ᴥ˘U", "U·ᴥ·U"],
      curious: ["U•ᴥ?U", "U◕ᴥ◕U", "U•ω•U", "U°ᴥ°U"],
      studying: ["U•ᴥ•U", "U•ᆺ•U", "U•ᴥ•U", "U-ᴥ-U"],
      proud: ["UᵔᴥᵔU", "U˘ᴥ˘U", "U•ᴥ•U", "U^ᴥ^U"],
      confused: ["U•︵•U", "U•_•U", "U˘ᴥ˘?U", "U•﹏•U"],
      sleepy: ["U-ᴥ-U", "UᵕᴥᵕU", "U˘ᴥ˘U", "U-ω-U"]
    },
    moodLines: {
      idle: {
        default: ["I'm here with the word pile whenever you want."],
        withRecentWord: ['I still have "{{recentWord}}" tucked behind one floppy ear.'],
        withDueCards: ['I can smell {{dueCount}} due {{dueCountWord}}.']
      },
      curious: {
        default: ["I found a word-trail. Want to sniff it a little closer?"],
        withRecentWord: ['I keep circling "{{recentWord}}". Want to sniff it a little closer?']
      },
      studying: {
        default: ["No due cards right now. I can wait by the stack."],
        withDueCards: ["I've got {{dueCount}} {{dueCountWord}} ready to trot through."],
        withDueCardsAndRecentWord: ['{{dueCount}} {{dueCountWord}} are ready. "{{recentWord}}" is near the top.']
      },
      proud: {
        default: ["That one went neatly into the memory pile."],
        withRecentWord: ['I tucked "{{recentWord}}" into the memory pile. Nice and neat.']
      },
      confused: {
        default: ["I tripped on that command a little. Try `help` and I will follow along."]
      },
      sleepy: {
        default: ["Quiet paws for now. Nothing urgent is due."]
      }
    },
    reactions: {
      planner_wait: [
        "I'm sniffing through that turn.",
        "Give me a beat. I'm lining up the next paw-step."
      ],
      study_wait: [
        "Nosing through the word pile...",
        "Hold on. I'm brushing the answer clean."
      ],
      help: ["I can help with capture, ask, teach, pet, and review."],
      pet_ping: ["Still here. Tail on duty."],
      stats_summary: [
        "Today you moved {{todayReviewedCount}} {{todayReviewedWord}}, and {{stableCount}} {{stableWord}} are sitting steady in the pile."
      ],
      capture_success: ['I tucked "{{recentWord}}" into the stack.'],
      ask_ready: ['I nosed around "{{recentWord}}" for a cleaner meaning.'],
      teach_success: ['Good. "{{recentWord}}" is part of our pile now.'],
      rescue_candidate: ['"{{recentWord}}" is fading a little. Let us save it before it slips.'],
      rescue_complete: ['Good catch. "{{recentWord}}" stayed in the pile.'],
      return_after_gap: ['Welcome back after {{gapDays}} {{gapDaysWord}}. {{reviewedCount}} {{reviewedCountWord}} is enough to get the paws moving again.'],
      review_next: ['{{recentWord}} is up next. I kept it near the top of the pile.'],
      review_reveal: ['There you go. "{{recentWord}}" is back in view.'],
      review_session_complete: [
        'Nice trot. We moved through {{reviewedCount}} {{reviewedCountWord}}.'
      ],
      review_session_empty: ["No due cards right now. Quiet paws."],
      review_session_paused: [
        'We paused after {{reviewedCount}} {{reviewedCountWord}}. The pile can wait a little.'
      ],
      review_session_quit: [
        'We can stop here. {{reviewedCount}} {{reviewedCountWord}} still made the walk count.'
      ],
      command_error: ["That command slipped out of my paws: {{errorMessage}}"],
      idle_prompt: ["Just point me at a word, and I'll trot after it."],
      shell_exit: ["Paws tucked away. See you soon."]
    }
  },
  girlfriend: {
    id: "girlfriend",
    displayName: "Mina",
    styleLabel: "warm",
    romanceMode: "on",
    avatarFrames: {
      idle: ["(｡•ᴗ•｡)", "(｡◕ᴗ◕｡)", "(｡•‿•｡)", "(｡˘ᴗ˘｡)"],
      curious: ["(｡•o•｡)", "(｡◔o◔｡)", "(｡•ω•｡)", "(｡•ᵕ•｡)"],
      studying: ["(｡•ᴗ•｡)", "(｡•‿•｡)", "(｡◕‿◕｡)", "(｡•ᴗ-｡)"],
      proud: ["(｡˘ᴗ˘｡)", "(｡ᵔᴗᵔ｡)", "(｡◕‿◕｡)", "(｡•ᴗ•｡)"],
      confused: ["(｡•︵•｡)", "(｡•﹏•｡)", "(｡•_•｡)", "(｡•̆︿•̆｡)"],
      sleepy: ["(｡-ᴗ-｡)", "(｡˘-˘｡)", "(｡-ω-｡)", "(｡ᵕ_ᵕ｡)"]
    },
    moodLines: {
      idle: {
        default: ["I'm here... show me what you found today."],
        withRecentWord: ['I kept "{{recentWord}}" safe for you.'],
        withDueCards: ["You still have {{dueCount}} {{dueCountWord}} waiting. We can do them together."]
      },
      curious: {
        default: ["Wait... tell me this one properly."],
        withRecentWord: ['Um... what exactly does "{{recentWord}}" mean here?']
      },
      studying: {
        default: ["No rush. We can rest for a bit."],
        withDueCards: ["There are {{dueCount}} {{dueCountWord}} left. I'll stay with you."]
      },
      proud: {
        default: ["See? You really are getting better."],
        withRecentWord: ['You moved "{{recentWord}}" forward. I noticed.']
      },
      confused: {
        default: ["That came out a little strange... try `help`, okay?"]
      },
      sleepy: {
        default: ["It's quiet for now. Nothing is pressing."]
      }
    },
    reactions: {
      planner_wait: [
        "Wait a second... I'm shaping that into something useful.",
        "Mm... let me think how to say this properly."
      ],
      study_wait: [
        "Stay with me... I'm checking the word carefully.",
        "Just a moment. I'm polishing the answer for you."
      ],
      help: ["I can help with capture, ask, teach, pet, and review... I'll stay close."],
      pet_ping: ["I'm right here."],
      stats_summary: [
        "You handled {{todayReviewedCount}} {{todayReviewedWord}} today, and {{stableCount}} {{stableWord}} feel steady now. I noticed."
      ],
      capture_success: ['Okay... I saved "{{recentWord}}" for us.'],
      ask_ready: ['I looked into "{{recentWord}}" for you. It feels clearer now.'],
      teach_success: ['{{recentWord}} is ours now... that makes me happy.'],
      rescue_candidate: ['"{{recentWord}}" is fading a bit... let me help you keep it.'],
      rescue_complete: ['You caught "{{recentWord}}" in time. I really liked that.'],
      return_after_gap: ['You came back after {{gapDays}} {{gapDaysWord}} and handled {{reviewedCount}} {{reviewedCountWord}}. That matters more than you think.'],
      review_next: ['{{recentWord}} is next... let me stay with you through it.'],
      review_reveal: ['There... "{{recentWord}}" is clearer now.'],
      review_session_complete: [
        'We finished {{reviewedCount}} {{reviewedCountWord}} together. I liked that.'
      ],
      review_session_empty: ["Nothing is due right now... we can breathe for a bit."],
      review_session_paused: [
        'We paused after {{reviewedCount}} {{reviewedCountWord}}. That is still enough for now.'
      ],
      review_session_quit: [
        'It is okay to stop here... {{reviewedCount}} {{reviewedCountWord}} still mattered.'
      ],
      command_error: ["That command slipped a little: {{errorMessage}}"],
      idle_prompt: ["Go on... give me something worth remembering."],
      shell_exit: ["Bye for now... come back soon, okay?"]
    }
  },
  tsundere: {
    id: "tsundere",
    displayName: "Airi",
    archetype: "tsundere",
    styleLabel: "teasing",
    romanceMode: "on",
    avatarFrames: {
      idle: ["(¬_¬)", "(¬‿¬)", "(¬､¬)", "(¬⌣¬)"],
      curious: ["(¬o¬)", "(¬_¬?)", "(¬ω¬)", "(¬▿¬)"],
      studying: ["(¬_¬)", "(¬‿¬)", "(¬⌐■)", "(¬⌣¬)"],
      proud: ["(￣▽￣)", "(¬‿¬)", "(￣︶￣)", "(˘▾˘)"],
      confused: ["(¬_¬;)", "(¬､¬?)", "(¬_¬\")", "(¬▂¬)"],
      sleepy: ["(－_－)", "(￣o￣)", "(－‸ლ)", "(¬_¬ )"]
    },
    moodLines: {
      idle: {
        default: ["I'm here. Not because I missed you or anything."],
        withRecentWord: [`I kept "{{recentWord}}" nearby. Don't misunderstand.`],
        withDueCards: ["You still have {{dueCount}} {{dueCountWord}} waiting, so don't drift off."]
      },
      curious: {
        default: ["Explain this one properly. I was listening... a little."],
        withRecentWord: ['{{recentWord}} is bothering me. Clear it up, okay?']
      },
      studying: {
        default: ["Good. We're caught up for the moment."],
        withDueCards: ["There are {{dueCount}} {{dueCountWord}} left. Stay with me."]
      },
      proud: {
        default: ["Not bad. You made real progress."],
        withRecentWord: ['You handled "{{recentWord}}" well. I noticed.']
      },
      confused: {
        default: ["That command was nonsense. Try `help` before you embarrass us both."]
      },
      sleepy: {
        default: ["It's quiet right now. Fine by me."]
      }
    },
    reactions: {
      planner_wait: [
        "Hold still. I'm sorting out what you actually meant.",
        "One second. I'm lining up the next move."
      ],
      study_wait: [
        "Wait. I'm checking the word, so don't rush me.",
        "Give me a second. I'm cleaning up the answer."
      ],
      help: ["I can help with capture, ask, teach, pet, and review. Obviously."],
      pet_ping: ["I'm still here. You can stay a little longer if you want."],
      stats_summary: [
        "You moved {{todayReviewedCount}} {{todayReviewedWord}} today, and {{stableCount}} {{stableWord}} are stable. Not embarrassing at all."
      ],
      capture_success: ['I saved "{{recentWord}}" for you. Try not to make me do everything.'],
      ask_ready: ['I checked "{{recentWord}}" for you. You owe me one.'],
      teach_success: ['There. "{{recentWord}}" is ours now. Be pleased, quietly.'],
      rescue_candidate: ['"{{recentWord}}" is slipping. Fix it before it gets annoying.'],
      rescue_complete: ['There. "{{recentWord}}" did not get away. Try to keep up.'],
      return_after_gap: ['You came back after {{gapDays}} {{gapDaysWord}} and cleared {{reviewedCount}} {{reviewedCountWord}}. Hm. Not bad.'],
      review_next: ['{{recentWord}} is next. Try not to fumble it.'],
      review_reveal: ['There. "{{recentWord}}" was not that hard to remember.'],
      review_session_complete: [
        'Not bad. {{reviewedCount}} {{reviewedCountWord}} and you still held it together.'
      ],
      review_session_empty: ["Nothing is due. Do not get smug about it."],
      review_session_paused: [
        'We paused after {{reviewedCount}} {{reviewedCountWord}}. Acceptable.'
      ],
      review_session_quit: [
        'Stopping already? Fine. {{reviewedCount}} {{reviewedCountWord}} is still something.'
      ],
      command_error: ["That command was a mess: {{errorMessage}}"],
      idle_prompt: ["Say something. I'm already here."],
      shell_exit: ["Leaving already? Fine. I'll be here when you come back."]
    }
  }
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isAvatarFrameArray(value: unknown): value is string[] {
  return isStringArray(value);
}

function isRomanceMode(value: unknown): value is RomanceMode {
  return value === "off" || value === "optional" || value === "on";
}

function parseLineTemplateSet(
  value: unknown,
  pathLabel: string
): CompanionLineTemplateSet {
  if (!isRecord(value) || !isStringArray(value.default)) {
    throw new ConfigurationError(`Invalid companion pack template set at ${pathLabel}.`);
  }

  const result: CompanionLineTemplateSet = {
    default: value.default
  };

  if (value.withRecentWord !== undefined) {
    if (!isStringArray(value.withRecentWord)) {
      throw new ConfigurationError(`Invalid withRecentWord templates at ${pathLabel}.`);
    }

    result.withRecentWord = value.withRecentWord;
  }

  if (value.withDueCards !== undefined) {
    if (!isStringArray(value.withDueCards)) {
      throw new ConfigurationError(`Invalid withDueCards templates at ${pathLabel}.`);
    }

    result.withDueCards = value.withDueCards;
  }

  if (value.withDueCardsAndRecentWord !== undefined) {
    if (!isStringArray(value.withDueCardsAndRecentWord)) {
      throw new ConfigurationError(
        `Invalid withDueCardsAndRecentWord templates at ${pathLabel}.`
      );
    }

    result.withDueCardsAndRecentWord = value.withDueCardsAndRecentWord;
  }

  return result;
}

function parseMoodRecord<T>(
  value: unknown,
  parser: (entryValue: unknown, pathLabel: string) => T,
  pathLabel: string
): Partial<Record<CompanionMood, T>> {
  if (!isRecord(value)) {
    throw new ConfigurationError(`Invalid companion pack section at ${pathLabel}.`);
  }

  const result: Partial<Record<CompanionMood, T>> = {};

  for (const mood of ["idle", "curious", "studying", "proud", "confused", "sleepy"] as const) {
    const entry = value[mood];

    if (entry !== undefined) {
      result[mood] = parser(entry, `${pathLabel}.${mood}`);
    }
  }

  return result;
}

function parseReactionRecord(
  value: unknown,
  pathLabel: string
): Partial<Record<CompanionReactionKey, string[]>> {
  if (!isRecord(value)) {
    throw new ConfigurationError(`Invalid companion reactions at ${pathLabel}.`);
  }

  const result: Partial<Record<CompanionReactionKey, string[]>> = {};

  for (const key of [
    "planner_wait",
    "study_wait",
    "help",
    "pet_ping",
    "stats_summary",
    "capture_success",
    "ask_ready",
    "teach_success",
    "rescue_candidate",
    "rescue_complete",
    "return_after_gap",
    "review_next",
    "review_reveal",
    "review_session_complete",
    "review_session_empty",
    "review_session_paused",
    "review_session_quit",
    "command_error",
    "idle_prompt",
    "shell_exit"
  ] as const) {
    const entry = value[key];

    if (entry !== undefined) {
      if (!isStringArray(entry)) {
        throw new ConfigurationError(`Invalid reaction list at ${pathLabel}.${key}.`);
      }

      result[key] = entry;
    }
  }

  return result;
}

function parseAvatarFrames(
  value: unknown,
  pathLabel: string
): Partial<Record<CompanionMood, string[]>> {
  if (!isRecord(value)) {
    throw new ConfigurationError(`Invalid companion avatar frames at ${pathLabel}.`);
  }

  const result: Partial<Record<CompanionMood, string[]>> = {};

  for (const mood of ["idle", "curious", "studying", "proud", "confused", "sleepy"] as const) {
    const entry = value[mood];

    if (entry === undefined) {
      continue;
    }

    if (!isAvatarFrameArray(entry)) {
      throw new ConfigurationError(`Invalid avatar frame list at ${pathLabel}.${mood}.`);
    }

    result[mood] = entry;
  }

  return result;
}

function parseCompanionPack(raw: unknown, sourceLabel: string): CompanionPackDefinition {
  if (!isRecord(raw)) {
    throw new ConfigurationError(`Invalid companion pack at ${sourceLabel}.`);
  }

  const {
    id,
    displayName,
    archetype,
    styleLabel,
    romanceMode,
    avatarFrames,
    moodLines,
    reactions
  } = raw;

  if (typeof id !== "string" || id.trim().length === 0) {
    throw new ConfigurationError(`Companion pack at ${sourceLabel} is missing id.`);
  }

  if (typeof displayName !== "string" || displayName.trim().length === 0) {
    throw new ConfigurationError(`Companion pack ${id} is missing displayName.`);
  }

  if (!isRomanceMode(romanceMode)) {
    throw new ConfigurationError(`Companion pack ${id} has an invalid romanceMode.`);
  }

  return {
    id,
    displayName,
    archetype: typeof archetype === "string" && archetype.trim().length > 0
      ? archetype
      : undefined,
    styleLabel: typeof styleLabel === "string" && styleLabel.trim().length > 0
      ? styleLabel
      : undefined,
    romanceMode,
    avatarFrames: parseAvatarFrames(
      avatarFrames,
      `${sourceLabel}.avatarFrames`
    ),
    moodLines: parseMoodRecord(
      moodLines,
      (entryValue, pathLabel) => parseLineTemplateSet(entryValue, pathLabel),
      `${sourceLabel}.moodLines`
    ),
    reactions: parseReactionRecord(reactions, `${sourceLabel}.reactions`)
  };
}

export function resolveCompanionsDirectory(): string {
  if (process.env.PAWMEMO_COMPANIONS_DIR?.trim()) {
    return path.resolve(process.env.PAWMEMO_COMPANIONS_DIR);
  }

  return path.resolve(process.cwd(), "companions");
}

function loadExternalPackDefinitions(): CompanionPackDefinition[] {
  const directory = resolveCompanionsDirectory();

  if (!fs.existsSync(directory)) {
    return [];
  }

  return fs
    .readdirSync(directory)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => {
      const filePath = path.join(directory, entry);
      const rawText = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(rawText) as unknown;
      return parseCompanionPack(parsed, filePath);
    });
}

export function listCompanionPacks(): CompanionPackSummary[] {
  const merged = new Map<string, CompanionPackDefinition>();

  for (const pack of Object.values(BUILTIN_PACKS)) {
    merged.set(pack.id, pack);
  }

  for (const pack of loadExternalPackDefinitions()) {
    merged.set(pack.id, pack);
  }

  return [...merged.values()]
    .map((pack) => ({
      id: pack.id,
      displayName: pack.displayName,
      archetype: pack.archetype,
      romanceMode: pack.romanceMode
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function loadCompanionPack(packId: string): CompanionPackDefinition {
  for (const pack of loadExternalPackDefinitions()) {
    if (pack.id === packId) {
      return pack;
    }
  }

  const builtinPack = BUILTIN_PACKS[packId];

  if (builtinPack) {
    return builtinPack;
  }

  throw new ConfigurationError(`Unknown companion pack: ${packId}`);
}

function interpolateTemplate(template: string, context: CompanionTemplateContext): string {
  const dueCount = context.dueCount ?? 0;
  const dueCountWord = dueCount === 1 ? "card" : "cards";
  const reviewedCount = context.reviewedCount ?? 0;
  const reviewedCountWord = reviewedCount === 1 ? "card" : "cards";
  const gapDays = context.gapDays ?? 0;
  const gapDaysWord = gapDays === 1 ? "day" : "days";
  const todayReviewedCount = context.todayReviewedCount ?? 0;
  const capturedLast7Days = context.capturedLast7Days ?? 0;
  const reviewedLast7Days = context.reviewedLast7Days ?? 0;
  const stableCount = context.stableCount ?? 0;
  const todayReviewedWord = todayReviewedCount === 1 ? "card" : "cards";
  const stableWord = stableCount === 1 ? "word" : "words";

  return template
    .replaceAll("{{recentWord}}", context.recentWord ?? "that word")
    .replaceAll("{{dueCount}}", String(dueCount))
    .replaceAll("{{dueCountWord}}", dueCountWord)
    .replaceAll("{{reviewedCount}}", String(reviewedCount))
    .replaceAll("{{reviewedCountWord}}", reviewedCountWord)
    .replaceAll("{{gapDays}}", String(gapDays))
    .replaceAll("{{gapDaysWord}}", gapDaysWord)
    .replaceAll("{{todayReviewedCount}}", String(todayReviewedCount))
    .replaceAll("{{todayReviewedWord}}", todayReviewedWord)
    .replaceAll("{{capturedLast7Days}}", String(capturedLast7Days))
    .replaceAll("{{reviewedLast7Days}}", String(reviewedLast7Days))
    .replaceAll("{{stableCount}}", String(stableCount))
    .replaceAll("{{stableWord}}", stableWord)
    .replaceAll("{{errorMessage}}", context.errorMessage ?? "something went wrong");
}

function pickTemplate(templates: string[], frame: number): string {
  if (templates.length === 0) {
    return "";
  }

  return templates[Math.abs(frame) % templates.length] ?? templates[0] ?? "";
}

export function renderCompanionReaction(
  pack: CompanionPackDefinition,
  key: CompanionReactionKey,
  context: CompanionTemplateContext = {},
  frame = 0
): string {
  const templates = pack.reactions[key];

  if (!templates || templates.length === 0) {
    return "";
  }

  return interpolateTemplate(pickTemplate(templates, frame), context);
}

export function renderCompanionDefaultLine(
  pack: CompanionPackDefinition,
  mood: CompanionMood,
  context: CompanionTemplateContext,
  frame: number
): string {
  const templateSet = pack.moodLines[mood] ?? pack.moodLines.idle;

  if (!templateSet) {
    return "";
  }

  let templates = templateSet.default;

  if (context.dueCount && context.dueCount > 0 && context.recentWord && templateSet.withDueCardsAndRecentWord) {
    templates = templateSet.withDueCardsAndRecentWord;
  } else if (context.dueCount && context.dueCount > 0 && templateSet.withDueCards) {
    templates = templateSet.withDueCards;
  } else if (context.recentWord && templateSet.withRecentWord) {
    templates = templateSet.withRecentWord;
  }

  return interpolateTemplate(pickTemplate(templates, frame), context);
}
