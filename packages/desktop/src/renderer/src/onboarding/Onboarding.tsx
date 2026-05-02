import * as React from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Brain,
  Check,
  Cpu,
  Eye,
  Layers,
  Loader2,
  Lock,
  Rocket,
  Search,
  Shield,
  Sparkles,
  X,
  Zap,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { BrandMark } from '@/components/BrandMark';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import {
  buildInstallPhases,
  formatBootstrapLine,
  pullPercent,
  type InstallPhase,
} from '@/lib/bootstrap-phases';
import { formatBytes, formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { Frame, ModelBootstrapProgress, RuntimeOverview } from '@/global';

type OnboardingStep =
  | 'welcome'
  | 'how-it-works'
  | 'privacy'
  | 'choose-model'
  | 'install-model'
  | 'first-capture'
  | 'first-search'
  | 'done';

const STEPS: OnboardingStep[] = [
  'welcome',
  'how-it-works',
  'privacy',
  'choose-model',
  'install-model',
  'first-capture',
  'first-search',
  'done',
];

interface ModelChoice {
  id: string;
  name: string;
  vendor: string;
  size: string;
  bytes: number;
  description: string;
  badge?: string;
}

const MODEL_CHOICES: ModelChoice[] = [
  {
    id: 'gemma2:2b',
    name: 'Gemma 2 · 2B',
    vendor: 'Google',
    size: '~1.6 GB',
    bytes: 1.6 * 1024 ** 3,
    description: 'Fast and lightweight. Great default for everyday work.',
    badge: 'Recommended',
  },
  {
    id: 'gemma3:4b',
    name: 'Gemma 3 · 4B',
    vendor: 'Google',
    size: '~3.3 GB',
    bytes: 3.3 * 1024 ** 3,
    description: 'Smarter answers. A bit larger and slower.',
  },
  {
    id: 'gemma2:9b',
    name: 'Gemma 2 · 9B',
    vendor: 'Google',
    size: '~5.4 GB',
    bytes: 5.4 * 1024 ** 3,
    description: 'Most capable. Needs a beefier Mac/PC and more disk.',
  },
];

export function Onboarding({
  bootstrapEvents,
  onClearBootstrapEvents,
  onComplete,
}: {
  bootstrapEvents: ModelBootstrapProgress[];
  onClearBootstrapEvents: () => void;
  onComplete: () => void;
}) {
  const [step, setStep] = React.useState<OnboardingStep>('welcome');
  const [chosenModel, setChosenModel] = React.useState<string>(MODEL_CHOICES[0]!.id);
  const [overview, setOverview] = React.useState<RuntimeOverview | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const initial = await window.cofounderos?.getOverview();
        if (cancelled || !initial) return;
        setOverview(initial);
        if (initial.capture.running && !initial.capture.paused) {
          try {
            await window.cofounderos.pauseCapture();
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    const timer = window.setInterval(async () => {
      try {
        const next = await window.cofounderos?.getOverview();
        if (next) setOverview(next);
      } catch {
        /* ignore */
      }
    }, 1500);
    return () => window.clearInterval(timer);
  }, []);

  const stepIndex = STEPS.indexOf(step);
  const progressPct = Math.round(((stepIndex + 1) / STEPS.length) * 100);

  function go(next: OnboardingStep) {
    setStep(next);
  }
  function goNext() {
    const idx = STEPS.indexOf(step);
    if (idx >= 0 && idx < STEPS.length - 1) go(STEPS[idx + 1]!);
  }
  function goBack() {
    const idx = STEPS.indexOf(step);
    if (idx > 0) go(STEPS[idx - 1]!);
  }

  async function finish() {
    try {
      const final = await window.cofounderos?.getOverview();
      if (final?.capture.running && final.capture.paused) {
        await window.cofounderos.resumeCapture();
      }
    } catch {
      /* ignore */
    }
    onComplete();
  }

  return (
    <div className="flex h-screen flex-col bg-background">
      <header className="app-drag flex items-center gap-4 border-b border-border px-6 py-3">
        <BrandMark className="size-7" />
        <span className="font-semibold text-sm">CofounderOS</span>
        <div className="flex-1 mx-6">
          <Progress value={progressPct} />
        </div>
        {step !== 'done' && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onComplete}
            className="app-no-drag"
          >
            Skip setup
          </Button>
        )}
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl px-6 py-10">
          {step === 'welcome' && <WelcomeStep onContinue={goNext} />}
          {step === 'how-it-works' && <HowItWorksStep onContinue={goNext} onBack={goBack} />}
          {step === 'privacy' && <PrivacyStep onContinue={goNext} onBack={goBack} />}
          {step === 'choose-model' && (
            <ChooseModelStep
              chosenModel={chosenModel}
              onChoose={setChosenModel}
              onContinue={goNext}
              onBack={goBack}
            />
          )}
          {step === 'install-model' && (
            <InstallModelStep
              chosenModel={chosenModel}
              bootstrapEvents={bootstrapEvents}
              modelReady={overview?.model.ready ?? false}
              onClearEvents={onClearBootstrapEvents}
              onContinue={goNext}
              onBack={goBack}
            />
          )}
          {step === 'first-capture' && (
            <FirstCaptureStep overview={overview} onContinue={goNext} onBack={goBack} />
          )}
          {step === 'first-search' && (
            <FirstSearchStep onContinue={goNext} onBack={goBack} />
          )}
          {step === 'done' && <DoneStep onFinish={finish} />}
        </div>
      </div>
    </div>
  );
}

function StepCard({
  eyebrow,
  title,
  lede,
  children,
  back,
  next,
}: {
  eyebrow?: string;
  title: string;
  lede?: string;
  children?: React.ReactNode;
  back?: { label?: string; onClick: () => void; disabled?: boolean };
  next?: {
    label: string;
    onClick: () => void;
    disabled?: boolean;
    variant?: 'default' | 'outline';
  };
}) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-6 py-2">
        {eyebrow ? (
          <div className="text-xs font-medium uppercase tracking-wide text-primary">
            {eyebrow}
          </div>
        ) : null}
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
          {lede ? (
            <p className="text-base text-muted-foreground mt-3 leading-relaxed">{lede}</p>
          ) : null}
        </div>
        {children}
        {(back || next) && (
          <div className="flex items-center justify-between gap-2 pt-2">
            <div>
              {back ? (
                <Button
                  variant="ghost"
                  onClick={back.onClick}
                  disabled={back.disabled}
                >
                  <ArrowLeft />
                  {back.label ?? 'Back'}
                </Button>
              ) : (
                <span />
              )}
            </div>
            {next ? (
              <Button
                size="lg"
                variant={next.variant ?? 'default'}
                onClick={next.onClick}
                disabled={next.disabled}
              >
                {next.label}
                <ArrowRight />
              </Button>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function WelcomeStep({ onContinue }: { onContinue: () => void }) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center text-center gap-5 py-8">
        <div className="size-16 rounded-2xl bg-primary/10 text-primary grid place-items-center">
          <Brain className="size-9" />
        </div>
        <h1 className="text-3xl font-semibold tracking-tight">Meet your second brain</h1>
        <p className="text-base text-muted-foreground max-w-md leading-relaxed">
          CofounderOS quietly remembers what you do on your computer — apps, docs, browsers — and
          turns it into a private, searchable memory you can ask anything.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Badge variant="outline">
            <Lock />
            100% local
          </Badge>
          <Badge variant="outline">
            <Shield />
            No cloud
          </Badge>
          <Badge variant="outline">
            <Zap />
            No subscription
          </Badge>
        </div>
        <Button size="xl" onClick={onContinue}>
          Get started
          <ArrowRight />
        </Button>
        <p className="text-xs text-muted-foreground">
          Takes about 2 minutes. We'll set up a small AI helper that runs on your Mac.
        </p>
      </CardContent>
    </Card>
  );
}

function HowItWorksStep({
  onContinue,
  onBack,
}: {
  onContinue: () => void;
  onBack: () => void;
}) {
  const items = [
    {
      icon: <Eye />,
      title: 'It watches what you work on',
      body: 'Every few seconds, CofounderOS notes the active app, window title, URL, and takes a small screenshot — only when something actually changed.',
    },
    {
      icon: <Layers />,
      title: 'It organizes everything for you',
      body: 'A local AI builds a tidy wiki of your work — projects, people, decisions — that updates itself in the background.',
    },
    {
      icon: <Search />,
      title: 'You can ask anything',
      body: 'Search "what was I doing yesterday afternoon?" or hand the memory to your favorite AI app (Cursor, Claude, ChatGPT) and let it answer for you.',
    },
  ];
  return (
    <StepCard
      eyebrow="How it works"
      title="Three quiet superpowers"
      back={{ onClick: onBack }}
      next={{ label: 'Continue', onClick: onContinue }}
    >
      <div className="flex flex-col gap-4">
        {items.map((it, i) => (
          <div
            key={i}
            className="flex gap-4 rounded-lg border border-border bg-muted/30 p-4"
          >
            <div className="size-9 shrink-0 rounded-md bg-primary/10 text-primary grid place-items-center">
              {it.icon}
            </div>
            <div>
              <h3 className="font-medium">{it.title}</h3>
              <p className="text-sm text-muted-foreground mt-1 leading-relaxed">{it.body}</p>
            </div>
          </div>
        ))}
      </div>
    </StepCard>
  );
}

function PrivacyStep({
  onContinue,
  onBack,
}: {
  onContinue: () => void;
  onBack: () => void;
}) {
  const promises = [
    {
      icon: <Lock />,
      title: 'Stays on your computer — always',
      body: 'Screenshots, notes, and the search index are stored only on this Mac. Nothing is uploaded, ever.',
    },
    {
      icon: <Cpu />,
      title: 'The AI runs locally too',
      body: 'We use a small open-source model (Google Gemma) that runs on your hardware. Your prompts never reach OpenAI, Google, Anthropic, or anyone else.',
    },
    {
      icon: <Shield />,
      title: 'No telemetry, no accounts, no cost',
      body: 'No analytics. No usage tracking. No sign-up. CofounderOS is open source — you can read every line.',
    },
    {
      icon: <Eye />,
      title: "You're always in control",
      body: 'Pause capture anytime from the menu bar. Tell us which apps to ignore. Set sensitive keywords to skip. Delete everything in one click.',
    },
  ];
  return (
    <StepCard
      eyebrow="Your privacy"
      title="Your memory never leaves this device"
      lede="Privacy isn't a setting we added later — it's the whole reason CofounderOS exists. Read this carefully:"
      back={{ onClick: onBack }}
      next={{ label: 'Sounds good', onClick: onContinue }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {promises.map((p, i) => (
          <div
            key={i}
            className="flex gap-3 rounded-lg border border-border bg-muted/30 p-4"
          >
            <div className="size-8 shrink-0 rounded-md bg-primary/10 text-primary grid place-items-center">
              {p.icon}
            </div>
            <div>
              <h3 className="font-medium text-sm">{p.title}</h3>
              <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{p.body}</p>
            </div>
          </div>
        ))}
      </div>
    </StepCard>
  );
}

function ChooseModelStep({
  chosenModel,
  onChoose,
  onContinue,
  onBack,
}: {
  chosenModel: string;
  onChoose: (id: string) => void;
  onContinue: () => void;
  onBack: () => void;
}) {
  return (
    <StepCard
      eyebrow="Choose your local AI"
      title="Pick a model to run on your computer"
      lede="We'll use Ollama (a free, open-source tool) to run the model offline. The smaller the model, the faster it runs and the less disk it uses."
      back={{ onClick: onBack }}
      next={{ label: 'Continue', onClick: onContinue }}
    >
      <RadioGroup value={chosenModel} onValueChange={onChoose} className="gap-2">
        {MODEL_CHOICES.map((m) => (
          <Label
            key={m.id}
            htmlFor={m.id}
            className={cn(
              'flex cursor-pointer items-start gap-4 rounded-lg border bg-card p-4 transition-colors',
              chosenModel === m.id ? 'border-primary ring-2 ring-primary/20' : 'hover:bg-accent/40',
            )}
          >
            <RadioGroupItem value={m.id} id={m.id} className="mt-1" />
            <div className="flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{m.name}</span>
                {m.badge && <Badge>{m.badge}</Badge>}
                <Badge variant="muted">{m.vendor}</Badge>
              </div>
              <p className="text-sm text-muted-foreground mt-1">{m.description}</p>
              <div className="flex flex-wrap items-center gap-3 mt-2 text-xs text-muted-foreground">
                <span>{m.size} download</span>
                <span>· Runs locally</span>
                <span>· Free</span>
              </div>
            </div>
          </Label>
        ))}
      </RadioGroup>
      <p className="text-xs text-muted-foreground">
        You can switch models later in Settings. If a download fails, CofounderOS falls back to a
        simple offline indexer so you can keep working.
      </p>
    </StepCard>
  );
}

function InstallModelStep({
  chosenModel,
  bootstrapEvents,
  modelReady,
  onClearEvents,
  onContinue,
  onBack,
}: {
  chosenModel: string;
  bootstrapEvents: ModelBootstrapProgress[];
  modelReady: boolean;
  onClearEvents: () => void;
  onContinue: () => void;
  onBack: () => void;
}) {
  const [phase, setPhase] = React.useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [autoStarted, setAutoStarted] = React.useState(false);

  const choice = MODEL_CHOICES.find((m) => m.id === chosenModel) ?? MODEL_CHOICES[0]!;

  React.useEffect(() => {
    if (autoStarted) return;
    setAutoStarted(true);
    void runInstall();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    if (modelReady && phase === 'running') setPhase('done');
  }, [modelReady, phase]);

  React.useEffect(() => {
    for (let i = bootstrapEvents.length - 1; i >= 0; i--) {
      const ev = bootstrapEvents[i]!;
      if (
        ev.kind === 'install_failed' ||
        ev.kind === 'pull_failed' ||
        ev.kind === 'server_failed'
      ) {
        if (phase !== 'error') {
          setPhase('error');
          setErrorMessage(ev.reason || `${ev.kind} failed`);
        }
        return;
      }
      if (ev.kind === 'ready') {
        if (phase !== 'done') setPhase('done');
        return;
      }
    }
  }, [bootstrapEvents, phase]);

  async function runInstall(): Promise<void> {
    if (phase === 'running') return;
    setErrorMessage(null);
    onClearEvents();
    setPhase('running');
    try {
      await window.cofounderos.saveConfigPatch({
        index: {
          model: {
            plugin: 'ollama',
            ollama: { model: choice.id, auto_install: true },
          },
        },
      });
      await window.cofounderos.bootstrapModel();
      setPhase('done');
    } catch (err) {
      setPhase('error');
      setErrorMessage(err instanceof Error ? err.message : String(err));
    }
  }

  const lastPullProgress = React.useMemo(() => {
    for (let i = bootstrapEvents.length - 1; i >= 0; i--) {
      const ev = bootstrapEvents[i]!;
      if (
        ev.kind === 'pull_progress' &&
        typeof ev.completed === 'number' &&
        typeof ev.total === 'number'
      ) {
        return ev;
      }
    }
    return null;
  }, [bootstrapEvents]);

  const phasesShown = React.useMemo(() => buildInstallPhases(bootstrapEvents), [bootstrapEvents]);

  const headline =
    phase === 'done'
      ? 'Your AI is ready'
      : phase === 'error'
        ? 'Setup ran into a snag'
        : `Installing ${choice.name}`;

  const lede =
    phase === 'done'
      ? 'Everything is installed and running on your computer. Time to capture your first moment.'
      : phase === 'error'
        ? "We couldn't finish the install. You can retry, or skip the AI and use the simple offline indexer for now."
        : "This is a one-time install. Nothing is uploaded — we're downloading the model directly to your computer.";

  return (
    <Card>
      <CardContent className="flex flex-col gap-5 py-2">
        <div className="text-xs font-medium uppercase tracking-wide text-primary">
          Setting up your local AI
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{headline}</h1>
          <p className="text-sm text-muted-foreground mt-2 leading-relaxed">{lede}</p>
        </div>

        <div className="flex flex-col gap-2">
          {phasesShown.map((p) => (
            <PhaseRow
              key={p.id}
              phase={p}
              progress={p.id === 'pull' && p.state === 'active' ? lastPullProgress : null}
            />
          ))}
        </div>

        {errorMessage && (
          <Alert variant="destructive">
            <X />
            <AlertTitle>Install failed</AlertTitle>
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        )}

        <details className="text-xs">
          <summary className="text-muted-foreground cursor-pointer select-none">
            Show technical log
          </summary>
          <pre className="mt-2 max-h-48 overflow-auto rounded-md border bg-muted/50 p-3 font-mono text-[11px] leading-snug">
            {bootstrapEvents.length === 0
              ? '(waiting for bootstrap to begin…)'
              : bootstrapEvents.slice(-25).map(formatBootstrapLine).join('\n')}
          </pre>
        </details>

        <div className="flex items-center justify-between gap-2 pt-2">
          <Button variant="ghost" onClick={onBack} disabled={phase === 'running'}>
            <ArrowLeft />
            Back
          </Button>
          <div className="flex items-center gap-2">
            {phase === 'error' && (
              <Button variant="outline" onClick={() => void runInstall()}>
                Try again
              </Button>
            )}
            {phase === 'error' && (
              <Button variant="ghost" onClick={onContinue}>
                Skip and continue
                <ArrowRight />
              </Button>
            )}
            {phase !== 'error' && (
              <Button size="lg" onClick={onContinue} disabled={phase !== 'done'}>
                {phase === 'done' ? 'Continue' : 'Working…'}
                {phase === 'done' && <ArrowRight />}
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function PhaseRow({
  phase,
  progress,
}: {
  phase: InstallPhase;
  progress: ModelBootstrapProgress | null;
}) {
  const dim = phase.state === 'pending';
  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-md border bg-card p-3',
        dim && 'opacity-60',
        phase.state === 'error' && 'border-destructive/40',
      )}
    >
      <div className="mt-0.5">
        {phase.state === 'done' ? (
          <Check className="size-4 text-success" />
        ) : phase.state === 'active' ? (
          <Loader2 className="size-4 animate-spin text-primary" />
        ) : phase.state === 'error' ? (
          <X className="size-4 text-destructive" />
        ) : (
          <span className="block size-2 rounded-full bg-muted-foreground/40 mt-1.5" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium">{phase.title}</div>
        {phase.detail && (
          <div className="text-xs text-muted-foreground mt-0.5">{phase.detail}</div>
        )}
        {progress && (
          <div className="flex flex-col gap-1 mt-2">
            <Progress value={pullPercent(progress)} />
            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
              <span>{progress.status || 'downloading'}</span>
              <span>
                {formatBytes((progress.completed as number) || 0)}
                {' / '}
                {formatBytes((progress.total as number) || 0)}
                {' · '}
                {pullPercent(progress)}%
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function FirstCaptureStep({
  overview,
  onContinue,
  onBack,
}: {
  overview: RuntimeOverview | null;
  onContinue: () => void;
  onBack: () => void;
}) {
  const [starting, setStarting] = React.useState(false);
  const [startError, setStartError] = React.useState<string | null>(null);
  const [didAttemptStart, setDidAttemptStart] = React.useState(false);
  const initialTotalRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    if (!overview) return;
    if (initialTotalRef.current == null) {
      initialTotalRef.current = overview.storage.totalEvents;
    }
  }, [overview]);

  const eventsToday = overview?.capture.eventsToday ?? 0;
  const totalEvents = overview?.storage.totalEvents ?? 0;
  const displayCount = eventsToday > 0 ? eventsToday : totalEvents;
  const baseline = initialTotalRef.current ?? totalEvents;
  const newSinceArrival = Math.max(0, totalEvents - baseline);
  const captureLive = !!overview?.capture.running && !overview.capture.paused;
  const capturePaused = !!overview?.capture.running && !!overview.capture.paused;
  const hasFirst = captureLive && (newSinceArrival >= 1 || displayCount >= 1);

  async function startCapturing(): Promise<void> {
    setStarting(true);
    setStartError(null);
    setDidAttemptStart(true);
    try {
      await window.cofounderos.startRuntime();
      try {
        await window.cofounderos.resumeCapture();
      } catch {
        /* may already be live */
      }
      for (let i = 0; i < 6; i++) {
        const next = await window.cofounderos.getOverview();
        if (next.capture.running && !next.capture.paused) break;
        await new Promise((r) => setTimeout(r, 500));
      }
    } catch (err) {
      setStartError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  }

  const showAdvance = captureLive || didAttemptStart;

  return (
    <Card>
      <CardContent className="flex flex-col gap-5 py-2">
        <div className="text-xs font-medium uppercase tracking-wide text-primary">
          Your first capture
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Let's record your first moment
          </h1>
          <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
            When you click Start, CofounderOS will quietly note the active app and take a small
            screenshot every few seconds — only when something changed. Try switching to another
            app or scrolling a doc.
          </p>
        </div>

        <div className="rounded-xl border bg-muted/30 p-6 flex flex-col items-center gap-4">
          <div
            className={cn(
              'size-16 rounded-full grid place-items-center transition-colors',
              captureLive
                ? 'bg-success/20 text-success ring-4 ring-success/20 animate-pulse'
                : 'bg-muted text-muted-foreground',
            )}
          >
            <Eye className="size-8" />
          </div>
          <div className="text-center">
            <div className="text-4xl font-semibold tracking-tight">{formatNumber(displayCount)}</div>
            <div className="text-xs text-muted-foreground mt-1">
              {eventsToday > 0
                ? displayCount === 1
                  ? 'moment captured today'
                  : 'moments captured today'
                : displayCount === 1
                  ? 'moment captured'
                  : 'moments captured'}
              {newSinceArrival > 0 && (
                <Badge variant="success" className="ml-2">
                  +{newSinceArrival} new
                </Badge>
              )}
            </div>
          </div>
          <div
            className={cn(
              'text-xs font-medium',
              captureLive
                ? 'text-success'
                : capturePaused
                  ? 'text-warning'
                  : 'text-muted-foreground',
            )}
          >
            {captureLive
              ? 'Capturing — try doing something on your computer'
              : capturePaused
                ? 'Capture is paused'
                : starting
                  ? 'Waking the capture engine…'
                  : 'Not capturing yet'}
          </div>
        </div>

        {startError && (
          <Alert variant="destructive">
            <X />
            <AlertTitle>Could not start capture</AlertTitle>
            <AlertDescription>{startError}</AlertDescription>
          </Alert>
        )}

        {didAttemptStart && !captureLive && !starting && (
          <Alert variant="warning">
            <Shield />
            <AlertTitle>Permissions needed</AlertTitle>
            <AlertDescription>
              On macOS this usually means CofounderOS needs <strong>Screen Recording</strong> and
              <strong> Accessibility</strong> permission. Open <em>System Settings → Privacy
              &amp; Security</em>, grant access to the CofounderOS app (or your terminal in dev
              mode), then try again.
            </AlertDescription>
          </Alert>
        )}

        <div className="flex items-center justify-between gap-2 pt-2">
          <Button variant="ghost" onClick={onBack}>
            <ArrowLeft />
            Back
          </Button>
          <div className="flex items-center gap-2">
            {!captureLive && (
              <Button size="lg" onClick={() => void startCapturing()} disabled={starting}>
                {starting ? 'Starting…' : didAttemptStart ? 'Try again' : 'Start capturing'}
              </Button>
            )}
            {captureLive ? (
              <Button size="lg" onClick={onContinue} disabled={!hasFirst}>
                {hasFirst ? 'Continue' : 'Waiting for first moment…'}
                {hasFirst && <ArrowRight />}
              </Button>
            ) : showAdvance || displayCount > 0 ? (
              <Button variant="ghost" onClick={onContinue}>
                Continue anyway
                <ArrowRight />
              </Button>
            ) : null}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function FirstSearchStep({
  onContinue,
  onBack,
}: {
  onContinue: () => void;
  onBack: () => void;
}) {
  const [query, setQuery] = React.useState('');
  const [results, setResults] = React.useState<Frame[] | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [searched, setSearched] = React.useState(false);

  async function runSearch(): Promise<void> {
    if (!query.trim()) return;
    setLoading(true);
    setSearched(true);
    try {
      const found = await window.cofounderos.searchFrames({ text: query.trim(), limit: 6 });
      setResults(found);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-5 py-2">
        <div className="text-xs font-medium uppercase tracking-wide text-primary">
          Try a search
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Ask your memory anything</h1>
          <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
            Type a word from something you just saw — an app name, a webpage title, or text on
            screen. CofounderOS searches everything you've captured so far. (No worries if there's
            nothing yet — give it a few minutes.)
          </p>
        </div>

        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
            <Input
              autoFocus
              placeholder="e.g. Cursor, GitHub, slack, design doc…"
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void runSearch();
              }}
              className="pl-9"
            />
          </div>
          <Button onClick={() => void runSearch()} disabled={loading || !query.trim()}>
            {loading ? 'Searching…' : 'Search'}
          </Button>
        </div>

        {searched && (
          <div className="flex flex-col gap-2">
            {results && results.length > 0 ? (
              results.map((f, i) => (
                <div
                  key={i}
                  className="flex gap-3 rounded-md border bg-card p-3 text-sm"
                >
                  <div className="font-mono text-xs text-muted-foreground w-12 shrink-0">
                    {(f.timestamp || '').slice(11, 16) || '—'}
                  </div>
                  <div className="min-w-0">
                    <div className="font-medium truncate">{f.app || 'Unknown app'}</div>
                    <div className="text-muted-foreground text-xs mt-0.5 line-clamp-2">
                      {f.window_title ||
                        f.url ||
                        (f.text ? String(f.text).replace(/\s+/g, ' ').slice(0, 140) : '—')}
                    </div>
                  </div>
                </div>
              ))
            ) : (
              <div className="rounded-md border border-dashed bg-muted/30 p-6 text-center">
                <p className="text-sm">No matches yet. That's normal — capture only just started.</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Try searching for an app you have open, like the one you're reading this in.
                </p>
              </div>
            )}
          </div>
        )}

        <div className="flex items-center justify-between gap-2 pt-2">
          <Button variant="ghost" onClick={onBack}>
            <ArrowLeft />
            Back
          </Button>
          <Button size="lg" onClick={onContinue}>
            {searched ? 'Looks good' : 'Skip for now'}
            <ArrowRight />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function DoneStep({ onFinish }: { onFinish: () => void }) {
  const items = [
    {
      icon: <Sparkles />,
      title: 'Browse your memories',
      body: 'See what you worked on, by day or session.',
    },
    {
      icon: <Sparkles />,
      title: 'Connect Cursor or Claude',
      body: 'Copy a tiny snippet so your AI app can ask your memory directly.',
    },
    {
      icon: <Sparkles />,
      title: 'Tune privacy & storage',
      body: "Exclude apps, set retention, change models. Everything's a click away.",
    },
  ];
  return (
    <Card>
      <CardContent className="flex flex-col items-center text-center gap-5 py-8">
        <div className="size-16 rounded-2xl bg-primary/10 text-primary grid place-items-center">
          <Rocket className="size-9" />
        </div>
        <h1 className="text-3xl font-semibold tracking-tight">You're all set</h1>
        <p className="text-base text-muted-foreground max-w-md leading-relaxed">
          CofounderOS is now remembering quietly in the background. Whenever you want to revisit
          something, open the menu bar icon — your memory will be waiting.
        </p>
        <div className="grid gap-2 w-full max-w-md">
          {items.map((it, i) => (
            <div
              key={i}
              className="flex items-start gap-3 rounded-lg border bg-muted/30 p-3 text-left"
            >
              <div className="size-8 shrink-0 rounded-md bg-primary/10 text-primary grid place-items-center">
                {it.icon}
              </div>
              <div>
                <h3 className="font-medium text-sm">{it.title}</h3>
                <p className="text-xs text-muted-foreground mt-0.5">{it.body}</p>
              </div>
            </div>
          ))}
        </div>
        <Button size="xl" onClick={onFinish}>
          Open CofounderOS
          <ArrowRight />
        </Button>
      </CardContent>
    </Card>
  );
}
