export type StudyCellKind =
  | "ask-result"
  | "review-intro"
  | "review-card"
  | "review-summary"
  | "rescue-intro"
  | "teach-draft";

export type StudyCardSectionRole =
  | "eyebrow"
  | "title"
  | "subtitle"
  | "prompt"
  | "answer"
  | "note"
  | "meta";

export interface StudyCardSection {
  role: StudyCardSectionRole;
  text: string;
}

export interface StudyCardViewModel {
  variant: StudyCellKind;
  sections: StudyCardSection[];
}

export interface StudyCellIntent {
  kind: StudyCellKind;
  title?: string;
  emphasis?: string | null;
  groupId?: string;
  view?: StudyCardViewModel;
}
