import type { ModelBootstrapProgress } from '@/global';

export interface InstallPhase {
  id: 'check' | 'install' | 'server' | 'pull' | 'ready';
  title: string;
  state: 'pending' | 'active' | 'done' | 'error';
  detail?: string;
}

export function pullPercent(ev: ModelBootstrapProgress): number {
  const total = (ev.total as number | undefined) ?? 0;
  const completed = (ev.completed as number | undefined) ?? 0;
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((completed / total) * 100)));
}

export function formatBootstrapLine(ev: ModelBootstrapProgress): string {
  switch (ev.kind) {
    case 'check':
      return `· ${ev.message ?? 'check'}`;
    case 'install_started':
      return `▸ Installing ${ev.tool ?? ''}…`;
    case 'install_log':
      return `  ${ev.line ?? ''}`;
    case 'install_done':
      return `✓ ${ev.tool ?? ''} installed`;
    case 'install_failed':
      return `✗ install failed: ${ev.reason ?? ''}`;
    case 'server_starting':
      return `▸ Starting Ollama at ${ev.host ?? ''}…`;
    case 'server_ready':
      return `✓ Ollama ready at ${ev.host ?? ''}`;
    case 'server_failed':
      return `✗ Ollama failed: ${ev.reason ?? ''}`;
    case 'pull_started':
      return `▸ Downloading ${ev.model ?? ''}…`;
    case 'pull_progress': {
      const pct = pullPercent(ev);
      return `  ${ev.status ?? 'progress'} ${pct}%`;
    }
    case 'pull_done':
      return `✓ ${ev.model ?? ''} downloaded`;
    case 'pull_failed':
      return `✗ ${ev.model ?? ''} failed: ${ev.reason ?? ''}`;
    case 'ready':
      return `✓ ${ev.model ?? ''} ready`;
    default:
      return ev.kind ?? '·';
  }
}

export function buildInstallPhases(events: ModelBootstrapProgress[]): InstallPhase[] {
  const phases: InstallPhase[] = [
    { id: 'check', title: 'Checking your setup', state: 'pending' },
    {
      id: 'install',
      title: 'Installing Ollama',
      state: 'pending',
      detail: 'A free, open-source tool to run AI locally',
    },
    { id: 'server', title: 'Starting the local AI service', state: 'pending' },
    {
      id: 'pull',
      title: 'Downloading the model',
      state: 'pending',
      detail: 'Direct from the model author to your computer',
    },
    { id: 'ready', title: 'Ready to go', state: 'pending' },
  ];
  const set = (id: InstallPhase['id'], state: InstallPhase['state'], detail?: string) => {
    const p = phases.find((x) => x.id === id);
    if (p) {
      p.state = state;
      if (detail) p.detail = detail;
    }
  };
  let sawAny = false;
  for (const ev of events) {
    sawAny = true;
    switch (ev.kind) {
      case 'check':
        set('check', 'active', ev.message);
        break;
      case 'install_started':
        set('check', 'done');
        set(
          'install',
          'active',
          `Running the official Ollama installer (${ev.tool ?? 'ollama'}). You may see a system prompt for permission.`,
        );
        break;
      case 'install_log':
        set('install', 'active', ev.line);
        break;
      case 'install_done':
        set('install', 'done');
        break;
      case 'install_failed':
        set('install', 'error', ev.reason);
        break;
      case 'server_starting':
        set('check', 'done');
        set('install', 'done');
        set('server', 'active', `Starting at ${ev.host ?? 'localhost'}…`);
        break;
      case 'server_ready':
        set('server', 'done');
        break;
      case 'server_failed':
        set('server', 'error', ev.reason);
        break;
      case 'pull_started':
        set('check', 'done');
        set('install', 'done');
        set('server', 'done');
        set('pull', 'active', `Fetching ${ev.model ?? 'model'}…`);
        break;
      case 'pull_progress':
        set('pull', 'active', ev.status);
        break;
      case 'pull_done':
        set('pull', 'done');
        break;
      case 'pull_failed':
        set('pull', 'error', ev.reason);
        break;
      case 'ready':
        set('check', 'done');
        set('install', 'done');
        set('server', 'done');
        set('pull', 'done');
        set('ready', 'done', 'All set');
        break;
    }
  }
  if (!sawAny) {
    phases[0]!.state = 'active';
    phases[0]!.detail = 'Looking for an existing Ollama install…';
  }
  return phases;
}
