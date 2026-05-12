import type { Meeting } from '@/global';
import { uniqueStrings } from '@/lib/collections';

export type MeetingSummary = NonNullable<Meeting['summary_json']>;
export type MeetingActionItem = MeetingSummary['action_items'][number];

export function readyMeetingSummaries(meetings: Meeting[]): MeetingSummary[] {
  return meetings
    .map((meeting) => meeting.summary_json)
    .filter((summary): summary is MeetingSummary => summary !== null);
}

export function actionItemLabel(item: MeetingActionItem): string {
  return item.owner ? `${item.owner}: ${item.task}` : item.task;
}

export function collectMeetingSummarySignals(meetings: Meeting[]): {
  summaries: MeetingSummary[];
  actionItems: MeetingSummary['action_items'];
  decisions: MeetingSummary['decisions'];
  openQuestions: MeetingSummary['open_questions'];
  links: string[];
} {
  const summaries = readyMeetingSummaries(meetings);
  return {
    summaries,
    actionItems: summaries.flatMap((summary) => summary.action_items),
    decisions: summaries.flatMap((summary) => summary.decisions),
    openQuestions: summaries.flatMap((summary) => summary.open_questions),
    links: uniqueStrings(summaries.flatMap((summary) => summary.links_shared)),
  };
}
