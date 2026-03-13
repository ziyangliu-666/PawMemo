export type StudyCellKind =
  | "review-intro"
  | "review-card"
  | "review-summary"
  | "rescue-intro";

export interface StudyCellIntent {
  kind: StudyCellKind;
  title?: string;
  emphasis?: string | null;
  groupId?: string;
}
