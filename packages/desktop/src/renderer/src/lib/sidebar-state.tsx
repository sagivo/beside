import * as React from 'react';

const STORAGE_KEY = 'beside:sidebar-collapsed';

interface SidebarContextValue {
  collapsed: boolean;
  toggle: () => void;
  setCollapsed: (collapsed: boolean) => void;
}

const SidebarContext = React.createContext<SidebarContextValue | null>(null);

function readInitial(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function SidebarStateProvider({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsedState] = React.useState<boolean>(readInitial);

  const setCollapsed = React.useCallback((next: boolean) => {
    setCollapsedState(next);
    try {
      if (next) localStorage.setItem(STORAGE_KEY, '1');
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  const toggle = React.useCallback(() => {
    setCollapsedState((v) => {
      const next = !v;
      try {
        if (next) localStorage.setItem(STORAGE_KEY, '1');
        else localStorage.removeItem(STORAGE_KEY);
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  const value = React.useMemo(
    () => ({ collapsed, toggle, setCollapsed }),
    [collapsed, toggle, setCollapsed],
  );

  return <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>;
}

export function useSidebar(): SidebarContextValue {
  const ctx = React.useContext(SidebarContext);
  if (!ctx) throw new Error('useSidebar must be used within <SidebarStateProvider>');
  return ctx;
}

/** Layout constants in rem; centralised so the save bar / shell can match. */
export const SIDEBAR_WIDTH_REM = 15; // w-60
export const SIDEBAR_COLLAPSED_REM = 3.5; // w-14

export function useSidebarWidthVar(): React.CSSProperties {
  const { collapsed } = useSidebar();
  return {
    ['--sidebar-w' as string]: `${collapsed ? SIDEBAR_COLLAPSED_REM : SIDEBAR_WIDTH_REM}rem`,
  };
}
