import * as React from 'react';
import type { ChatMessage, Insight, InsightEvidence } from '@/global';

const STORAGE_KEY = 'cofounderos:insight-chats:v1';
const MAX_SESSIONS = 50;

export interface InsightChatSession {
  id: string;
  title: string;
  insightId?: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
  evidence?: InsightEvidence;
}

interface ChatStore {
  sessions: InsightChatSession[];
}

function readStore(): ChatStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { sessions: [] };
    const parsed = JSON.parse(raw) as unknown;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !Array.isArray((parsed as { sessions?: unknown }).sessions)
    ) {
      return { sessions: [] };
    }
    const sessions = ((parsed as { sessions: unknown[] }).sessions
      .filter(isSession) as InsightChatSession[])
      .slice(0, MAX_SESSIONS);
    return { sessions };
  } catch {
    return { sessions: [] };
  }
}

function writeStore(store: ChatStore): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ sessions: store.sessions.slice(0, MAX_SESSIONS) }),
    );
  } catch {
    /* localStorage may be unavailable; ignore */
  }
}

function isSession(value: unknown): value is InsightChatSession {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<InsightChatSession>;
  return (
    typeof v.id === 'string' &&
    typeof v.title === 'string' &&
    typeof v.createdAt === 'string' &&
    typeof v.updatedAt === 'string' &&
    Array.isArray(v.messages)
  );
}

function newId(prefix: string): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${random}`;
}

export function useInsightChats() {
  const [sessions, setSessions] = React.useState<InsightChatSession[]>(() => readStore().sessions);
  const [activeId, setActiveId] = React.useState<string | null>(() => readStore().sessions[0]?.id ?? null);

  React.useEffect(() => {
    writeStore({ sessions });
  }, [sessions]);

  const upsertSession = React.useCallback((session: InsightChatSession) => {
    setSessions((prev) => {
      const without = prev.filter((entry) => entry.id !== session.id);
      const next = [session, ...without];
      return next.slice(0, MAX_SESSIONS);
    });
    setActiveId(session.id);
  }, []);

  const removeSession = React.useCallback((id: string) => {
    setSessions((prev) => prev.filter((entry) => entry.id !== id));
    setActiveId((prev) => {
      if (prev !== id) return prev;
      const remaining = sessions.filter((entry) => entry.id !== id);
      return remaining[0]?.id ?? null;
    });
  }, [sessions]);

  const clearAll = React.useCallback(() => {
    setSessions([]);
    setActiveId(null);
  }, []);

  const startEmptySession = React.useCallback((title?: string): InsightChatSession => {
    const now = new Date().toISOString();
    const session: InsightChatSession = {
      id: newId('chat'),
      title: title ?? 'New chat',
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    upsertSession(session);
    return session;
  }, [upsertSession]);

  const startSessionFromInsight = React.useCallback((insight: Insight): InsightChatSession => {
    const now = new Date().toISOString();
    const seedQuestion = `Tell me more about "${insight.title}". Why is this happening, and what should I do next?`;
    const session: InsightChatSession = {
      id: newId('chat'),
      title: insight.title.slice(0, 80),
      insightId: insight.id,
      createdAt: now,
      updatedAt: now,
      evidence: insight.evidence,
      messages: [
        {
          role: 'user',
          content: seedQuestion,
          createdAt: now,
        },
      ],
    };
    upsertSession(session);
    return session;
  }, [upsertSession]);

  const appendMessage = React.useCallback(
    (sessionId: string, message: ChatMessage, evidence?: InsightEvidence) => {
      setSessions((prev) => prev.map((session) => {
        if (session.id !== sessionId) return session;
        const merged: InsightChatSession = {
          ...session,
          updatedAt: new Date().toISOString(),
          messages: [...session.messages, message],
          evidence: evidence ?? session.evidence,
        };
        return merged;
      }));
    },
    [],
  );

  const renameSession = React.useCallback((id: string, title: string) => {
    setSessions((prev) => prev.map((session) => (
      session.id === id ? { ...session, title: title.slice(0, 80) } : session
    )));
  }, []);

  const activeSession = React.useMemo(
    () => sessions.find((session) => session.id === activeId) ?? null,
    [sessions, activeId],
  );

  return {
    sessions,
    activeSession,
    activeId,
    setActiveId,
    upsertSession,
    appendMessage,
    removeSession,
    renameSession,
    clearAll,
    startEmptySession,
    startSessionFromInsight,
  };
}
