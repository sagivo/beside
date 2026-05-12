import type { DayEventSource, DayEventKind } from '@/global';

export const DAY_EVENT_KIND_LABELS: Record<DayEventKind, string> = {
  meeting: 'Meeting',
  calendar: 'Calendar',
  communication: 'Communication',
  task: 'Task',
  other: 'Event',
};

export const DAY_EVENT_SOURCE_LABELS: Record<DayEventSource, string> = {
  meeting_capture: 'Captured call',
  calendar_screen: 'Seen on calendar',
  email_screen: 'Seen in inbox',
  slack_screen: 'Seen in Slack',
  task_screen: 'Seen in tasks',
  other_screen: 'Seen on screen',
};

export const DAY_EVENT_SOURCE_SHORT_LABELS: Record<DayEventSource, string> = {
  meeting_capture: 'Captured call',
  calendar_screen: 'Calendar',
  email_screen: 'Email',
  slack_screen: 'Slack',
  task_screen: 'Tasks',
  other_screen: 'Screen',
};

export const DAY_EVENT_KIND_COLORS: Record<DayEventKind, string> = {
  meeting: 'text-red-500 dark:text-red-300',
  calendar: 'text-amber-500 dark:text-amber-300',
  communication: 'text-blue-500 dark:text-blue-300',
  task: 'text-emerald-500 dark:text-emerald-300',
  other: 'text-muted-foreground',
};

export function dayEventSourceLabel(source: DayEventSource): string {
  return DAY_EVENT_SOURCE_LABELS[source] ?? source;
}

export function dayEventSourceShortLabel(source: DayEventSource): string {
  return DAY_EVENT_SOURCE_SHORT_LABELS[source] ?? source;
}
