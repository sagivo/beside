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
  Mic,
  RefreshCw,
  Rocket,
  Search,
  Shield,
  Sparkles,
  X,
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
import { formatBytes } from '@/lib/format';
import { MODEL_CHOICES } from '@/lib/model-catalog';
import { cn } from '@/lib/utils';
import type {
  MicPermission,
  ModelBootstrapProgress,
  RuntimeOverview,
  WhisperInstaller,
  WhisperProbe,
} from '@/global';

type OnboardingStep =
  | 'welcome'
  | 'how-it-works'
  | 'privacy'
  | 'choose-model'
  | 'install-model'
  | 'audio'
  | 'done';

const STEPS: OnboardingStep[] = [
  'welcome',
  'how-it-works',
  'privacy',
  'choose-model',
  'install-model',
  'audio',
  'done',
];

const STEP_LABELS: Record<OnboardingStep, string> = {
  welcome: 'Welcome',
  'how-it-works': 'How it works',
  privacy: 'Privacy',
  'choose-model': 'Local AI',
  'install-model': 'Install',
  audio: 'Audio',
  done: 'Done',
};

// Model catalog is shared with Settings → AI; edit it in
// `lib/model-catalog.ts`.

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

  // Subscribe to live overview push (heartbeat plus after every mutation).
  // Falls back to a sparse manual poll only if the push channel
  // isn't available — important because onboarding decides when to advance
  // based on capture state changing.
  React.useEffect(() => {
    if (window.cofounderos?.onOverview) {
      window.cofounderos.onOverview((next) => setOverview(next));
      return;
    }
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
  const modelReady = overview?.model.ready ?? false;

  const scrollRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0, behavior: 'auto' });
  }, [step]);

  function go(next: OnboardingStep) {
    setStep(next);
  }
  function goNext() {
    const idx = STEPS.indexOf(step);
    if (idx >= 0 && idx < STEPS.length - 1) go(STEPS[idx + 1]!);
  }
  function goToInstall() {
    go('install-model');
  }
  function goBack() {
    const idx = STEPS.indexOf(step);
    if (idx > 0) go(STEPS[idx - 1]!);
  }

  async function finish() {
    let final: RuntimeOverview | null | undefined = null;
    try {
      final = await window.cofounderos?.getOverview();
      // Onboarding no longer makes the user click "Start capturing" — ensure
      // the runtime is up and capture is live before we hand off the app.
      if (!final?.capture.running) {
        try {
          await window.cofounderos.startRuntime();
        } catch {
          /* ignore */
        }
      }
      try {
        await window.cofounderos.resumeCapture();
      } catch {
        /* may already be live */
      }
      final = (await window.cofounderos?.getOverview()) ?? final;
    } catch {
      /* ignore */
    }
    if (!(final?.model.ready ?? modelReady)) {
      go('install-model');
      return;
    }
    onComplete();
  }

  return (
    <div className="flex h-screen flex-col bg-background bg-[radial-gradient(circle_at_top,_rgba(96,165,250,0.16),_transparent_32rem)]">
      <header className="app-drag flex items-center gap-4 border-b border-border bg-background/85 px-6 py-3 backdrop-blur">
        <BrandMark className="size-7" />
        <span className="font-semibold text-sm">CofounderOS</span>
        <div className="flex-1 mx-6 flex flex-col gap-1.5">
          <div className="flex items-center justify-between text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            <span>{STEP_LABELS[step]}</span>
            <span>
              {stepIndex + 1} / {STEPS.length}
            </span>
          </div>
          <Progress value={progressPct} />
        </div>
        {step !== 'done' && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onComplete}
            disabled={!modelReady}
            title={
              modelReady
                ? 'Skip the rest of setup'
                : 'Install the local AI model first — CofounderOS needs it to run.'
            }
            className="app-no-drag"
          >
            Skip setup
          </Button>
        )}
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div
          className={cn(
            'mx-auto px-6 py-8 sm:py-10',
            step === 'welcome' ? 'max-w-5xl' : 'max-w-4xl',
          )}
        >
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
              modelReady={modelReady}
              onClearEvents={onClearBootstrapEvents}
              onContinue={goNext}
              onBack={goBack}
            />
          )}
          {step === 'audio' && <AudioStep onContinue={goNext} onBack={goBack} />}
          {step === 'done' && (
            <DoneStep
              modelReady={modelReady}
              onFinish={finish}
              onInstallModel={goToInstall}
            />
          )}
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
    <Card className="overflow-hidden py-0">
      <CardContent className="p-0">
        <div className="border-b border-border bg-muted/20 px-6 py-6 sm:px-8">
          {eyebrow ? (
            <div className="text-xs font-medium uppercase tracking-wide text-primary">
              {eyebrow}
            </div>
          ) : null}
          <div className="mt-3 max-w-2xl">
            <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
            {lede ? (
              <p className="text-base text-muted-foreground mt-3 leading-relaxed">{lede}</p>
            ) : null}
          </div>
          <PrivacyPillRow className="mt-5" />
        </div>

        <div className="flex flex-col gap-6 p-6 sm:p-8">
          {children}
          <PrivacyNote />
        </div>

        {(back || next) && (
          <div className="flex items-center justify-between gap-2 border-t border-border bg-muted/10 px-6 py-4 sm:px-8">
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

function PrivacyPillRow({
  className,
  compact = false,
}: {
  className?: string;
  compact?: boolean;
}) {
  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      <Badge variant="outline" className={compact ? 'text-[11px]' : undefined}>
        <Lock />
        Local by default
      </Badge>
      <Badge variant="outline" className={compact ? 'text-[11px]' : undefined}>
        <Shield />
        Encrypted memory
      </Badge>
      <Badge variant="outline" className={compact ? 'text-[11px]' : undefined}>
        <Eye />
        Only you can see it
      </Badge>
    </div>
  );
}

function PrivacyNote({
  children = 'Your memory stays local, encrypted, and visible only to you unless you choose otherwise.',
  className,
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-lg border border-primary/20 bg-primary/5 p-4 text-sm text-muted-foreground',
        className,
      )}
    >
      <Shield className="mt-0.5 size-4 shrink-0 text-primary" />
      <p className="leading-relaxed">{children}</p>
    </div>
  );
}

function FeatureTile({
  icon,
  title,
  body,
  className,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  className?: string;
}) {
  return (
    <div className={cn('flex gap-3 rounded-lg border border-border bg-card p-4', className)}>
      <div className="size-9 shrink-0 rounded-md bg-primary/10 text-primary grid place-items-center">
        {icon}
      </div>
      <div>
        <h3 className="font-medium text-sm">{title}</h3>
        <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{body}</p>
      </div>
    </div>
  );
}

function WelcomeStep({ onContinue }: { onContinue: () => void }) {
  return (
    <Card className="relative overflow-hidden border-primary/15 py-0">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(circle at 20% 0%, rgba(96,165,250,0.22), transparent 45%), radial-gradient(circle at 90% 100%, rgba(168,85,247,0.18), transparent 55%)',
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/60 to-transparent"
      />

      <CardContent className="relative p-0">
        <div className="flex flex-col items-center px-6 pb-10 pt-14 text-center sm:px-12 sm:pt-20 sm:pb-14">
          <BrandHeroMark />

          <Badge
            variant="outline"
            className="mt-7 gap-1.5 border-primary/30 bg-primary/10 px-3 py-1 text-[11px] font-medium uppercase tracking-wide text-primary"
          >
            <Sparkles className="size-3" />
            Private memory for your work
          </Badge>

          <h1 className="mt-5 max-w-3xl text-balance text-4xl font-semibold tracking-tight sm:text-6xl">
            Your work,{' '}
            <span className="bg-gradient-to-r from-primary via-sky-400 to-violet-400 bg-clip-text text-transparent">
              perfectly remembered.
            </span>
          </h1>

          <p className="mt-5 max-w-xl text-base text-muted-foreground leading-relaxed sm:text-lg">
            A second brain that quietly captures what you do — and lets you search it later. Local,
            encrypted, and only you can see it.
          </p>

          <PrivacyPillRow className="mt-7 justify-center" />

          <div className="mt-8 flex flex-col items-center gap-3">
            <Button size="xl" onClick={onContinue} className="px-8">
              Get started
              <ArrowRight />
            </Button>
            <p className="text-xs text-muted-foreground">
              Takes about 2 minutes. Runs entirely on your computer.
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function BrandHeroMark() {
  return (
    <div className="relative grid place-items-center">
      <div
        aria-hidden
        className="absolute size-40 rounded-full bg-primary/20 blur-3xl"
      />
      <div
        aria-hidden
        className="absolute size-28 rounded-full bg-violet-500/20 blur-2xl"
      />
      <div className="relative flex size-20 items-center justify-center rounded-2xl border border-primary/30 bg-gradient-to-br from-primary/30 via-primary/10 to-violet-500/20 shadow-[0_0_40px_-10px_rgba(96,165,250,0.55)]">
        <Brain className="size-10 text-primary" />
      </div>
    </div>
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
      title: 'Capture useful context',
      body: 'CofounderOS notes the active app, window title, URL, and a small screenshot only when something changes.',
    },
    {
      icon: <Layers />,
      title: 'Organize it locally',
      body: 'A local AI turns those moments into projects, people, and decisions without sending your memory elsewhere.',
    },
    {
      icon: <Search />,
      title: 'Ask your private memory',
      body: 'Search what happened yesterday, where a decision was made, or what changed in a project.',
    },
  ];
  return (
    <StepCard
      eyebrow="How it works"
      title="A private memory in three steps"
      lede="Onboarding sets up the local pieces first: capture, encrypted storage, and private search."
      back={{ onClick: onBack }}
      next={{ label: 'Continue', onClick: onContinue }}
    >
      <div className="grid gap-3 md:grid-cols-3">
        {items.map((it) => (
          <FeatureTile key={it.title} icon={it.icon} title={it.title} body={it.body} />
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
      title: 'Stored locally',
      body: 'Screenshots, notes, and the search index live in your CofounderOS data folder on this device.',
    },
    {
      icon: <Shield />,
      title: 'Encrypted memory',
      body: 'The memory store is designed around encrypted local data, so your history remains yours.',
    },
    {
      icon: <Cpu />,
      title: 'Private processing',
      body: 'The model runs on your hardware, keeping prompts and summaries on the same machine.',
    },
    {
      icon: <Eye />,
      title: 'You stay in control',
      body: 'Pause capture, ignore apps, skip sensitive keywords, and delete your memory whenever you want.',
    },
  ];
  return (
    <StepCard
      title="Privacy: local, encrypted, only yours"
      lede="Privacy isn't a setting we added later — it's the product shape. You control what gets remembered, when capture runs, and what stays on disk."
      back={{ onClick: onBack }}
      next={{ label: 'Sounds good', onClick: onContinue }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {promises.map((p) => (
          <FeatureTile key={p.title} icon={p.icon} title={p.title} body={p.body} />
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
      title="Pick the private model that runs on this device"
      lede="CofounderOS uses Ollama, an open-source tool, so search and summaries can be processed locally. The smaller the model, the faster it runs and the less disk it uses."
      back={{ onClick: onBack }}
      next={{ label: 'Continue', onClick: onContinue }}
    >
      <RadioGroup value={chosenModel} onValueChange={onChoose} className="grid gap-3 lg:grid-cols-3">
        {MODEL_CHOICES.map((m) => (
          <Label
            key={m.id}
            htmlFor={m.id}
            className={cn(
              'flex h-full cursor-pointer items-start gap-4 rounded-xl border bg-card p-4 transition-colors',
              chosenModel === m.id ? 'border-primary ring-2 ring-primary/20' : 'hover:bg-accent/40',
            )}
          >
            <RadioGroupItem value={m.id} id={m.id} className="mt-1" />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{m.name}</span>
                {m.badge && <Badge>{m.badge}</Badge>}
                <Badge variant="muted">{m.vendor}</Badge>
              </div>
              <p className="text-sm text-muted-foreground">{m.description}</p>
              <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                <span>{m.size} download</span>
                <span>· Runs locally</span>
                <span>· Private processing</span>
              </div>
            </div>
          </Label>
        ))}
      </RadioGroup>
      <p className="text-xs text-muted-foreground">
        You can switch models later in Settings. If a download fails, CofounderOS falls back to a
        simple local indexer so you can keep working.
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
      ? 'Everything is installed and running locally. Time to capture your first private moment.'
      : phase === 'error'
        ? "We couldn't finish the install. You can retry, or continue with the simple local indexer for now."
        : 'This is a one-time download for private processing on this device. Your memory stays local and encrypted while the model installs.';

  return (
    <Card className="overflow-hidden py-0">
      <CardContent className="p-0">
        <div className="border-b border-border bg-muted/20 px-6 py-6 sm:px-8">
          <div className="text-xs font-medium uppercase tracking-wide text-primary">
            Setting up your local AI
          </div>
          <div className="mt-3 max-w-2xl">
            <h1 className="text-3xl font-semibold tracking-tight">{headline}</h1>
            <p className="text-base text-muted-foreground mt-3 leading-relaxed">{lede}</p>
          </div>
          <PrivacyPillRow className="mt-5" />
        </div>

        <div className="flex flex-col gap-6 p-6 sm:p-8">
          <div className="grid gap-2">
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

          <PrivacyNote>
            The model gives CofounderOS private reasoning on your device. Captured memory remains
            local, encrypted, and visible only to you.
          </PrivacyNote>

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

          <div className="flex items-center justify-between gap-2 border-t border-border pt-4">
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


function AudioStep({
  onContinue,
  onBack,
}: {
  onContinue: () => void;
  onBack: () => void;
}) {
  const [enabled, setEnabled] = React.useState(false);
  const [whisper, setWhisper] = React.useState<WhisperProbe | null>(null);
  const [installer, setInstaller] = React.useState<WhisperInstaller | null | undefined>(
    undefined,
  );
  const [installState, setInstallState] = React.useState<
    'idle' | 'running' | 'failed' | 'finished'
  >('idle');
  const [installLog, setInstallLog] = React.useState<string[]>([]);
  const [installError, setInstallError] = React.useState<string | null>(null);
  const [activeInstaller, setActiveInstaller] = React.useState<WhisperInstaller | null>(
    null,
  );
  const [mic, setMic] = React.useState<MicPermission | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);

  const refreshProbes = React.useCallback(async () => {
    try {
      const [w, m] = await Promise.all([
        window.cofounderos.probeWhisper(),
        window.cofounderos.probeMicPermission(),
      ]);
      setWhisper(w);
      setMic(m);
    } catch {
      /* ignore */
    }
  }, []);

  React.useEffect(() => {
    void refreshProbes();
    void window.cofounderos
      .detectWhisperInstaller()
      .then((res) => setInstaller(res.installer))
      .catch(() => setInstaller(null));
  }, [refreshProbes]);

  // Subscribe to live install progress streamed from the main process.
  React.useEffect(() => {
    if (!window.cofounderos.onWhisperInstallProgress) return;
    window.cofounderos.onWhisperInstallProgress((event) => {
      if (event.kind === 'started') {
        setInstallState('running');
        setInstallError(null);
        setInstallLog([`$ ${event.message ?? `${event.installer} install openai-whisper`}`]);
        setActiveInstaller(event.installer);
      } else if (event.kind === 'log') {
        setInstallLog((prev) => [...prev.slice(-80), event.message]);
      } else if (event.kind === 'finished') {
        setInstallState(event.available ? 'finished' : 'failed');
        if (!event.available) {
          setInstallError(
            "We installed Whisper but couldn't find it on PATH afterwards. Try running the app from a fresh terminal session.",
          );
        }
        void refreshProbes();
      } else if (event.kind === 'failed') {
        setInstallState('failed');
        setInstallError(event.reason ?? 'Install failed.');
      }
    });
  }, [refreshProbes]);

  async function commit(turnOn: boolean) {
    setBusy(true);
    setSaveError(null);
    try {
      if (turnOn && mic?.status === 'not-determined') {
        const after = await window.cofounderos.requestMicPermission();
        setMic(after);
      }
      await window.cofounderos.saveConfigPatch({
        capture: {
          capture_audio: turnOn,
          // Ensure live recording flips with the master toggle while
          // staying gated on another app using microphone input.
          audio: {
            live_recording: {
              enabled: turnOn,
              activation: 'other_process_input',
              poll_interval_sec: 3,
            },
          },
        },
      });
      setEnabled(turnOn);
      // Once turned on, kick the installer automatically if Whisper isn't
      // already there — saves the user from having to click again.
      if (
        turnOn &&
        whisper &&
        !whisper.available &&
        installer &&
        installState === 'idle'
      ) {
        void runInstall();
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function runInstall() {
    setInstallState('running');
    setInstallError(null);
    setInstallLog([]);
    try {
      const res = await window.cofounderos.installWhisper();
      if (!res.started) {
        setInstallState('failed');
        setInstallError(res.reason ?? 'Could not start the installer.');
      } else if (res.installer) {
        setActiveInstaller(res.installer);
      }
    } catch (err) {
      setInstallState('failed');
      setInstallError(err instanceof Error ? err.message : String(err));
    }
  }

  const ready = enabled && whisper?.available;
  const installerDetectionDone = installer !== undefined;
  const needsInstall = enabled && whisper && !whisper.available;
  const micDenied = enabled && mic?.status === 'denied';
  const canAutoInstall = installer != null;

  return (
    <StepCard
      eyebrow="Optional"
      title="Add private microphone memory"
      lede="If you turn this on, CofounderOS records short microphone chunks only while another app is using audio input, transcribes them locally with Whisper, and keeps the searchable transcript in your encrypted memory."
      back={{ onClick: onBack }}
      next={{
        label: enabled ? 'Continue' : 'Skip for now',
        onClick: onContinue,
        variant: enabled ? 'default' : 'outline',
      }}
    >
      <div className="rounded-xl border bg-card p-4 flex items-start gap-4 shadow-sm">
        <div className="size-10 shrink-0 rounded-md bg-primary/10 text-primary grid place-items-center">
          <Mic className="size-5" />
        </div>
        <div className="flex-1">
          <h3 className="font-medium">Capture meeting audio privately</h3>
          <p className="text-sm text-muted-foreground mt-1 leading-relaxed">
            When another app activates the microphone, audio is chunked every 5 minutes,
            transcribed on your device, then deleted by default. The redacted transcript is what
            stays in your local encrypted memory.
          </p>
        </div>
        <div className="pt-1">
          <Button
            size="sm"
            variant={enabled ? 'outline' : 'default'}
            onClick={() => void commit(!enabled)}
            disabled={busy}
          >
            {busy ? <Loader2 className="animate-spin" /> : enabled ? 'Turn off' : 'Turn on'}
          </Button>
        </div>
      </div>

      {saveError && (
        <Alert variant="destructive">
          <X />
          <AlertTitle>Could not save</AlertTitle>
          <AlertDescription>{saveError}</AlertDescription>
        </Alert>
      )}

      {enabled && (
        <div className="flex flex-col gap-3">
          <StatusRow
            label="Speech-to-text engine"
            status={
              whisper === null
                ? 'pending'
                : whisper.available
                  ? 'ok'
                  : installState === 'running'
                    ? 'installing'
                    : 'missing'
            }
            detail={
              whisper === null
                ? 'Checking…'
                : whisper.available
                  ? 'Installed and ready.'
                  : installState === 'running'
                    ? `Installing in the background${activeInstaller ? ` via ${activeInstaller}` : ''}…`
                    : 'Not installed yet — CofounderOS can install it for you in one click.'
            }
          />
          {mic && mic.status !== 'unsupported' && (
            <StatusRow
              label="Microphone permission"
              status={
                mic.status === 'granted'
                  ? 'ok'
                  : mic.status === 'denied' || mic.status === 'restricted'
                    ? 'missing'
                    : 'pending'
              }
              detail={
                mic.status === 'granted'
                  ? 'Granted — we can record while another app is using audio input.'
                  : mic.status === 'denied'
                    ? 'Denied. Open System Settings → Privacy & Security → Microphone, and enable CofounderOS.'
                    : mic.status === 'restricted'
                      ? "Restricted by a profile or parental control. We can't record."
                      : 'Will prompt the first time recording starts.'
              }
            />
          )}
        </div>
      )}

      {needsInstall && installerDetectionDone && canAutoInstall && (
        <div className="rounded-xl border bg-card p-4 flex flex-col gap-3 shadow-sm">
          <div className="flex items-start gap-3">
            <div className="size-9 shrink-0 grid place-items-center rounded-md bg-primary/10 text-primary">
              {installState === 'running' ? (
                <Loader2 className="size-4 animate-spin" />
              ) : installState === 'finished' ? (
                <Check className="size-4" />
              ) : installState === 'failed' ? (
                <X className="size-4 text-destructive" />
              ) : (
                <Mic className="size-4" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <h4 className="font-medium text-sm">
                {installState === 'finished'
                  ? 'Whisper is installed and ready'
                  : installState === 'running'
                    ? 'Installing Whisper privately on your device…'
                    : installState === 'failed'
                      ? 'Whisper install ran into a snag'
                      : `One-click install with ${installer}`}
              </h4>
              <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                {installState === 'running'
                  ? 'This usually takes a minute or two. You can keep going through onboarding while it finishes.'
                  : installState === 'failed'
                    ? installError ?? 'See the log below for details.'
                    : 'CofounderOS will run the install for you using your existing package manager. Nothing leaves this device.'}
              </p>
            </div>
            {installState !== 'running' && (
              <Button
                size="sm"
                variant={installState === 'failed' ? 'outline' : 'default'}
                onClick={() => void runInstall()}
              >
                {installState === 'failed' ? (
                  <>
                    <RefreshCw />
                    Try again
                  </>
                ) : (
                  'Install Whisper'
                )}
              </Button>
            )}
          </div>

          <InstallLogDisclosure log={installLog} />
        </div>
      )}

      {needsInstall && installerDetectionDone && !canAutoInstall && (
        <Alert variant="warning">
          <Shield />
          <AlertTitle>We can't auto-install Whisper here</AlertTitle>
          <AlertDescription>
            CofounderOS couldn't find Homebrew, pipx, or pip on your system. Conditional audio
            capture will queue files from future mic sessions until Whisper becomes available. You
            can install one of those tools and come back, or skip this step for now.
          </AlertDescription>
        </Alert>
      )}

      {micDenied && (
        <Alert variant="warning">
          <Shield />
          <AlertTitle>Microphone access denied</AlertTitle>
          <AlertDescription>
            Open <em>System Settings → Privacy &amp; Security → Microphone</em> and enable
            CofounderOS, then come back to this step.
          </AlertDescription>
        </Alert>
      )}

      {ready && (
        <Alert>
          <Check />
          <AlertTitle>You're ready</AlertTitle>
          <AlertDescription>
            Audio capture will arm with the runtime and start only while another app is using audio
            input. You can change this anytime in Settings → Audio; transcripts stay local and
            private.
          </AlertDescription>
        </Alert>
      )}
    </StepCard>
  );
}

function InstallLogDisclosure({ log }: { log: string[] }) {
  if (log.length === 0) return null;
  return (
    <details className="text-xs">
      <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">
        Show install details
      </summary>
      <pre className="mt-2 max-h-40 overflow-auto rounded-md border bg-muted/50 p-3 font-mono text-[11px] leading-snug">
        {log.slice(-12).join('\n')}
      </pre>
    </details>
  );
}

function StatusRow({
  label,
  status,
  detail,
}: {
  label: string;
  status: 'ok' | 'missing' | 'pending' | 'installing';
  detail?: string;
}) {
  return (
    <div className="flex items-start gap-3 rounded-md border bg-card p-3">
      <div className="mt-0.5">
        {status === 'ok' ? (
          <Check className="size-4 text-success" />
        ) : status === 'installing' ? (
          <Mic className="size-4 text-muted-foreground" />
        ) : status === 'missing' ? (
          <X className="size-4 text-destructive" />
        ) : (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium">{label}</div>
        {detail && (
          <div className="text-xs text-muted-foreground mt-0.5 break-words">{detail}</div>
        )}
      </div>
    </div>
  );
}

function DoneStep({
  modelReady,
  onFinish,
  onInstallModel,
}: {
  modelReady: boolean;
  onFinish: () => void;
  onInstallModel: () => void;
}) {
  const items = [
    {
      icon: <Search />,
      title: 'Search your private timeline',
      body: 'Revisit captured moments by day, session, app, or remembered detail.',
    },
    {
      icon: <Sparkles />,
      title: 'Use memory where you choose',
      body: 'Connect tools like Cursor or Claude only when you decide to share access.',
    },
    {
      icon: <Shield />,
      title: 'Tune privacy and storage',
      body: 'Exclude apps, change retention, switch models, or delete the encrypted memory.',
    },
  ];
  return (
    <Card className="overflow-hidden py-0">
      <CardContent className="p-0">
        <div className="border-b border-border bg-muted/20 px-6 py-8 text-center sm:px-8">
          <div className="mx-auto size-16 rounded-2xl bg-primary/10 text-primary grid place-items-center">
            <Rocket className="size-9" />
          </div>
          <h1 className="mt-5 text-3xl font-semibold tracking-tight">You're all set</h1>
          <p className="mx-auto mt-3 max-w-xl text-base text-muted-foreground leading-relaxed">
            CofounderOS is now ready to remember quietly in the background, with a local encrypted
            memory only you can see and control.
          </p>
          <PrivacyPillRow className="mt-5 justify-center" />
        </div>

        <div className="flex flex-col gap-6 p-6 sm:p-8">
          <div className="grid gap-3 md:grid-cols-3">
            {items.map((it) => (
              <FeatureTile key={it.title} icon={it.icon} title={it.title} body={it.body} />
            ))}
          </div>
          <PrivacyNote>
            You can pause capture from the menu bar and change privacy settings anytime. Your local
            memory remains encrypted and under your control.
          </PrivacyNote>
          {!modelReady && (
            <Alert variant="warning">
              <Shield />
              <AlertTitle>Local AI not installed yet</AlertTitle>
              <AlertDescription>
                CofounderOS needs the local model to organize and answer questions about your
                memory. Finish installing it before opening the app.
              </AlertDescription>
            </Alert>
          )}
          <div className="flex justify-center border-t border-border pt-4">
            {modelReady ? (
              <Button size="xl" onClick={onFinish}>
                Open CofounderOS
                <ArrowRight />
              </Button>
            ) : (
              <Button size="xl" onClick={onInstallModel}>
                Install local AI
                <ArrowRight />
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
