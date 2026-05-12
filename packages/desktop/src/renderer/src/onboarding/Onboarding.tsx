import * as React from 'react';
import { ArrowLeft, ArrowRight, Brain, Check, CheckCircle2, Cpu, Eye, ExternalLink, Keyboard, Layers, Loader2, Lock, Mic, Monitor, RefreshCw, Rocket, Search, Shield, ShieldCheck, Sparkles, X } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { BrandMark } from '@/components/BrandMark';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import { buildInstallPhases, formatBootstrapLine, pullPercent, type InstallPhase } from '@/lib/bootstrap-phases';
import { formatBytes } from '@/lib/format';
import { MODEL_CHOICES } from '@/lib/model-catalog';
import { cn } from '@/lib/utils';
import { ONBOARDING_MODEL_KEY, ONBOARDING_STEP_KEY } from '@/types';
import type { AccessibilityPermission, MicPermission, ModelBootstrapProgress, RuntimeOverview, ScreenPermission, WhisperInstaller, WhisperProbe } from '@/global';

type OnboardingStep = 'welcome' | 'how-it-works' | 'privacy' | 'permissions' | 'choose-model' | 'install-model' | 'audio' | 'done';
const STEPS: OnboardingStep[] = ['welcome', 'how-it-works', 'privacy', 'permissions', 'choose-model', 'install-model', 'audio', 'done'];
const STEP_LABELS: Record<OnboardingStep, string> = { welcome: 'Welcome', 'how-it-works': 'How it works', privacy: 'Privacy', permissions: 'Permissions', 'choose-model': 'Local AI', 'install-model': 'Install', audio: 'Audio', done: 'Done' };

export function Onboarding({ bootstrapEvents, onClearBootstrapEvents, onComplete }: { bootstrapEvents: ModelBootstrapProgress[]; onClearBootstrapEvents: () => void; onComplete: () => void; }) {
  const [step, setStep] = React.useState<OnboardingStep>(() => { try { const s = localStorage.getItem(ONBOARDING_STEP_KEY); return s && (STEPS as string[]).includes(s) ? s as OnboardingStep : 'welcome'; } catch { return 'welcome'; } });
  const [chosenModel, setChosenModel] = React.useState<string>(() => { try { const s = localStorage.getItem(ONBOARDING_MODEL_KEY); return s && MODEL_CHOICES.some((m) => m.id === s) ? s : MODEL_CHOICES[0]!.id; } catch { return MODEL_CHOICES[0]!.id; } });
  const [overview, setOverview] = React.useState<RuntimeOverview | null>(null), [screen, setScreen] = React.useState<ScreenPermission | null>(null), [accessibility, setAccessibility] = React.useState<AccessibilityPermission | null>(null);

  React.useEffect(() => { try { if (step === 'done') localStorage.removeItem(ONBOARDING_STEP_KEY); else localStorage.setItem(ONBOARDING_STEP_KEY, step); } catch {} }, [step]);
  React.useEffect(() => { try { localStorage.setItem(ONBOARDING_MODEL_KEY, chosenModel); } catch {} }, [chosenModel]);

  React.useEffect(() => {
    let c = false;
    (async () => { try { const initial = await window.beside?.getOverview(); if (c || !initial) return; setOverview(initial); if (initial.capture.running && !initial.capture.paused) await window.beside.pauseCapture(); } catch {} })();
    return () => { c = true; };
  }, []);

  React.useEffect(() => {
    if (window.beside?.onOverview) return window.beside.onOverview(setOverview);
    const t = window.setInterval(async () => { try { const n = await window.beside?.getOverview(); if (n) setOverview(n); } catch {} }, 1500); return () => window.clearInterval(t);
  }, []);

  const refreshPermissions = React.useCallback(async () => { try { const [s, a] = await Promise.all([window.beside.probeScreenPermission(), window.beside.probeAccessibilityPermission()]); setScreen(s); setAccessibility(a); } catch {} }, []);
  React.useEffect(() => { refreshPermissions(); }, [refreshPermissions]);

  const stepIndex = STEPS.indexOf(step), progressPct = Math.round(((stepIndex + 1) / STEPS.length) * 100);
  const modelReady = overview?.model.ready ?? false, screenOk = screen ? ['granted', 'unsupported'].includes(screen.status) : false, screenNeedsRelaunch = screen?.needsRelaunch === true;
  const gateMet = { screen: screenOk && !screenNeedsRelaunch, model: modelReady }, allGatesMet = gateMet.screen && gateMet.model;

  const scrollRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => { scrollRef.current?.scrollTo({ top: 0, behavior: 'auto' }); }, [step]);

  const go = (n: OnboardingStep) => setStep(n), goNext = () => STEPS.indexOf(step) < STEPS.length - 1 && go(STEPS[STEPS.indexOf(step) + 1]!), goBack = () => STEPS.indexOf(step) > 0 && go(STEPS[STEPS.indexOf(step) - 1]!);

  async function finish() {
    let f = overview;
    try { f = await window.beside?.getOverview(); if (!f?.capture.running) await window.beside.startRuntime(); await window.beside.resumeCapture(); f = await window.beside?.getOverview(); } catch {}
    if (!gateMet.screen) return go('permissions');
    if (!(f?.model.ready ?? modelReady)) return go('install-model');
    onComplete();
  }

  return (
    <div className="flex h-screen flex-col bg-background bg-gradient-ambient">
      <header className="app-drag flex items-center gap-4 border-b border-border bg-background/85 px-6 py-3 backdrop-blur"><BrandMark className="size-7" /><span className="font-semibold text-sm">Beside</span>
        <div className="flex-1 mx-6 flex flex-col gap-1.5"><div className="flex items-center justify-between text-[11px] font-medium uppercase text-muted-foreground"><span>{STEP_LABELS[step]}</span><span>{stepIndex + 1} / {STEPS.length}</span></div><Progress value={progressPct} /></div>
        {step !== 'done' && <Button variant="ghost" size="sm" onClick={onComplete} disabled={!allGatesMet} title={allGatesMet ? 'Skip setup' : !gateMet.screen ? 'Grant Screen Recording first.' : 'Install local AI first.'} className="app-no-drag">Skip setup</Button>}
      </header>
      {screenNeedsRelaunch && step !== 'done' && <div className="border-b border-warning/40 bg-warning/10 px-6 py-3"><div className="mx-auto flex max-w-4xl items-center gap-4"><RefreshCw className="size-4 text-warning" /><div className="flex-1 text-sm"><span className="font-medium text-warning">Screen Recording granted.</span> <span className="text-muted-foreground">Restart required.</span></div><Button size="sm" onClick={() => window.beside.relaunchApp()}><RefreshCw />Restart</Button></div></div>}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className={cn('mx-auto px-6 py-8 sm:py-10', step === 'welcome' ? 'max-w-5xl' : 'max-w-4xl')}>
          {step === 'welcome' && <WelcomeStep onContinue={goNext} />}
          {step === 'how-it-works' && <HowItWorksStep onContinue={goNext} onBack={goBack} />}
          {step === 'privacy' && <PrivacyStep onContinue={goNext} onBack={goBack} />}
          {step === 'permissions' && <PermissionsStep screen={screen} accessibility={accessibility} onRefresh={refreshPermissions} onContinue={goNext} onBack={goBack} />}
          {step === 'choose-model' && <ChooseModelStep chosenModel={chosenModel} onChoose={setChosenModel} onContinue={goNext} onBack={goBack} />}
          {step === 'install-model' && <InstallModelStep chosenModel={chosenModel} bootstrapEvents={bootstrapEvents} modelReady={modelReady} onClearEvents={onClearBootstrapEvents} onContinue={goNext} onBack={goBack} />}
          {step === 'audio' && <AudioStep onContinue={goNext} onBack={goBack} />}
          {step === 'done' && <DoneStep gateMet={gateMet} onFinish={finish} onInstallModel={() => go('install-model')} onGoToPermissions={() => go('permissions')} />}
        </div>
      </div>
    </div>
  );
}

function StepCard({ eyebrow, title, lede, children, back, next, footerHint }: any) {
  return (
    <Card className="overflow-hidden py-0"><CardContent className="p-0">
      <div className="border-b border-border bg-muted/20 px-6 py-6 sm:px-8">{eyebrow && <div className="text-xs font-medium uppercase text-primary">{eyebrow}</div>}<div className="mt-3 max-w-2xl"><h1 className="text-3xl font-semibold">{title}</h1>{lede && <p className="text-base text-muted-foreground mt-3">{lede}</p>}</div><div className="mt-5 flex gap-2"><Badge variant="outline"><Lock />Local by default</Badge><Badge variant="outline"><Shield />Encrypted memory</Badge><Badge variant="outline"><Eye />Only you see it</Badge></div></div>
      <div className="flex flex-col gap-6 p-6 sm:p-8">{children}<div className="flex items-start gap-3 rounded-lg border border-primary/20 bg-primary/5 p-4 text-sm text-muted-foreground"><Shield className="mt-0.5 size-4 shrink-0 text-primary" /><p>Your memory stays local, encrypted, and visible only to you.</p></div></div>
      {(back || next) && <div className="flex items-center justify-between border-t border-border bg-muted/10 px-6 py-4 sm:px-8"><div>{back ? <Button variant="ghost" onClick={back.onClick} disabled={back.disabled}><ArrowLeft />{back.label ?? 'Back'}</Button> : <span />}</div><div className="flex items-center gap-3">{footerHint}{next ? <Button size="lg" variant={next.variant ?? 'default'} onClick={next.onClick} disabled={next.disabled}>{next.label}<ArrowRight /></Button> : null}</div></div>}
    </CardContent></Card>
  );
}

function WelcomeStep({ onContinue }: any) {
  return (
    <Card className="relative overflow-hidden border-primary/15 py-0">
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-gradient-ambient opacity-90" />
      <CardContent className="relative p-0"><div className="flex flex-col items-center px-6 pb-10 pt-14 text-center sm:px-12 sm:pt-20 sm:pb-14">
        <div className="relative grid place-items-center"><div className="absolute size-40 rounded-full bg-primary/25 blur-3xl" /><div className="relative flex size-20 items-center justify-center rounded-2xl border border-primary/30 bg-gradient-brand text-primary-foreground shadow-glow"><Brain className="size-10" /></div></div>
        <Badge variant="outline" className="mt-7 gap-1.5 border-primary/30 bg-primary/10 px-3 py-1 text-[11px] font-medium uppercase text-primary"><Sparkles className="size-3" />Private memory</Badge>
        <h1 className="mt-5 max-w-3xl text-balance text-4xl font-semibold sm:text-6xl">Your work, <span className="text-gradient-brand">perfectly remembered.</span></h1>
        <p className="mt-5 max-w-xl text-base text-muted-foreground sm:text-lg">An ambient second brain that sits quietly beside you — capturing what you do, so you can focus on doing it. Local, encrypted, and private.</p>
        <div className="mt-8 flex flex-col items-center gap-3"><Button size="xl" onClick={onContinue} className="px-8">Get started<ArrowRight /></Button><p className="text-xs text-muted-foreground">Takes ~5 minutes. Runs entirely on your computer.</p></div>
      </div></CardContent>
    </Card>
  );
}

function FeatureTile({ icon, title, body }: any) { return <div className="flex gap-3 rounded-lg border bg-card p-4"><div className="size-9 shrink-0 rounded-md bg-primary/10 text-primary grid place-items-center">{icon}</div><div><h3 className="font-medium text-sm">{title}</h3><p className="text-xs text-muted-foreground mt-1">{body}</p></div></div>; }

function HowItWorksStep({ onContinue, onBack }: any) {
  return (
    <StepCard eyebrow="How it works" title="A private memory" lede="Onboarding sets up capture, storage, and search." back={{ onClick: onBack }} next={{ label: 'Continue', onClick: onContinue }}>
      <div className="grid gap-3 md:grid-cols-3">
        <FeatureTile icon={<Eye />} title="Capture context" body="Notes active app, URL, and screenshots on changes." />
        <FeatureTile icon={<Layers />} title="Organize locally" body="AI turns moments into projects and decisions." />
        <FeatureTile icon={<Search />} title="Ask memory" body="Search what happened yesterday or decisions made." />
      </div>
    </StepCard>
  );
}

function PrivacyStep({ onContinue, onBack }: any) {
  return (
    <StepCard title="Privacy: local, encrypted" lede="Privacy is the product shape. You control capture." back={{ onClick: onBack }} next={{ label: 'Sounds good', onClick: onContinue }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <FeatureTile icon={<Lock />} title="Stored locally" body="Screenshots and index live on your device." />
        <FeatureTile icon={<Shield />} title="Encrypted memory" body="Memory store is encrypted." />
        <FeatureTile icon={<Cpu />} title="Private processing" body="Model runs on your hardware." />
        <FeatureTile icon={<Eye />} title="You stay in control" body="Pause capture or delete memory anytime." />
      </div>
    </StepCard>
  );
}

function PermissionsStep({ screen, accessibility, onRefresh, onContinue, onBack }: any) {
  const [req, setReq] = React.useState<string | null>(null);
  React.useEffect(() => { const t = setInterval(onRefresh, 1000); return () => clearInterval(t); }, [onRefresh]);
  React.useEffect(() => { window.addEventListener('focus', onRefresh); return () => window.removeEventListener('focus', onRefresh); }, [onRefresh]);

  const wrapReq = (k: string, fn: any) => async () => { setReq(k); try { await fn(); } finally { setReq(null); onRefresh(); } };
  const sSup = screen?.status !== 'unsupported', aSup = accessibility?.status !== 'unsupported', sOk = screen?.status === 'granted' || !sSup, sRelaunch = screen?.needsRelaunch;
  const sPhase = !screen ? 'idle' : sRelaunch ? 'needs-relaunch' : sOk ? 'granted' : req === 'screen' ? 'requesting' : screen.status === 'not-determined' ? 'idle' : 'waiting';
  const aPhase = !accessibility ? 'idle' : ['granted', 'unsupported'].includes(accessibility.status) ? 'granted' : req === 'accessibility' ? 'requesting' : 'waiting';

  if (!sSup && !aSup) return <StepCard title="System permissions"><p>Not applicable on your OS.</p></StepCard>;
  return (
    <StepCard eyebrow="One-time setup" title="Give Beside what it needs" lede="Screen Recording and Accessibility permissions are needed for capture." back={{ onClick: onBack }} next={{ label: 'Continue', onClick: onContinue, disabled: !sOk, title: sOk ? undefined : 'Grant Screen Recording first.' }}>
      <div className="flex flex-col gap-3">
        {sSup && <PermissionCard icon={<Monitor className="size-5" />} title="Screen Recording" req="required" phase={sPhase} onReq={wrapReq('screen', window.beside.requestScreenPermission)} onSet={() => window.beside.openPermissionSettings('screen')} msg={sPhase === 'granted' ? 'Granted.' : sPhase === 'needs-relaunch' ? 'Restart required.' : 'Not granted.'} />}
        {aSup && <PermissionCard icon={<Keyboard className="size-5" />} title="Accessibility" req="recommended" phase={aPhase} onReq={wrapReq('accessibility', window.beside.requestAccessibilityPermission)} onSet={() => window.beside.openPermissionSettings('accessibility')} msg={aPhase === 'granted' ? 'Granted.' : 'Not granted.'} />}
      </div>
    </StepCard>
  );
}

function PermissionCard({ icon, title, req, phase, onReq, onSet, msg }: any) {
  const g = phase === 'granted', nr = phase === 'needs-relaunch';
  return (
    <div className={cn('flex items-start gap-4 rounded-xl border bg-card p-5', g && 'border-success/40 bg-success/5', nr && 'border-warning/40 bg-warning/5')}>
      <div className={cn('size-12 shrink-0 grid place-items-center rounded-lg', g ? 'bg-success/15 text-success' : nr ? 'bg-warning/15 text-warning' : 'bg-primary/10 text-primary')}>{g ? <Check className="size-5" /> : icon}</div>
      <div className="flex-1"><div className="flex gap-2 font-medium">{title} <Badge variant={req === 'required' ? 'default' : 'muted'}>{req === 'required' ? 'Required' : 'Recommended'}</Badge></div><p className="text-sm text-muted-foreground mt-1.5">{msg}</p></div>
      <div className="flex flex-col gap-2">{nr ? <Button onClick={() => window.beside.relaunchApp()}><RefreshCw />Restart</Button> : !g ? <Button variant={req === 'required' ? 'default' : 'outline'} onClick={onReq} disabled={phase === 'requesting'}>{phase === 'requesting' ? <Loader2 className="animate-spin" /> : 'Grant'}</Button> : <Button variant="ghost" disabled><Check />Granted</Button>} {!g && !nr && <Button variant="ghost" size="sm" onClick={onSet}>Settings</Button>}</div>
    </div>
  );
}

function ChooseModelStep({ chosenModel, onChoose, onContinue, onBack }: any) {
  return (
    <StepCard eyebrow="Choose your local AI" title="Pick the private model" lede="Models run locally on your hardware." back={{ onClick: onBack }} next={{ label: 'Continue', onClick: onContinue }}>
      <RadioGroup value={chosenModel} onValueChange={onChoose} className="grid gap-3 lg:grid-cols-3">
        {MODEL_CHOICES.map(m => <Label key={m.id} className={cn('p-4 border rounded-xl cursor-pointer flex gap-4', chosenModel === m.id ? 'border-primary ring-2 ring-primary/20' : 'hover:bg-accent/40')}><RadioGroupItem value={m.id} /><div className="flex-1"><div className="font-medium">{m.name}</div><p className="text-sm text-muted-foreground mt-1">{m.description}</p></div></Label>)}
      </RadioGroup>
    </StepCard>
  );
}

function InstallModelStep({ chosenModel, bootstrapEvents, modelReady, onClearEvents, onContinue, onBack }: any) {
  const [phase, setPhase] = React.useState<'idle'|'running'|'done'|'error'>('idle'), [err, setErr] = React.useState<string|null>(null);
  React.useEffect(() => {
    if (phase !== 'idle') return; setPhase('running'); onClearEvents();
    window.beside.saveConfigPatch({ index: { model: { plugin: 'ollama', ollama: { model: chosenModel, auto_install: true } } } })
      .then(() => window.beside.bootstrapModel()).then(() => setPhase('done')).catch(e => { setPhase('error'); setErr(e.message); });
  }, [phase, chosenModel, onClearEvents]);

  React.useEffect(() => {
    if (modelReady && phase !== 'done') setPhase('done');
    for (let i = bootstrapEvents.length - 1; i >= 0; i--) {
      const ev = bootstrapEvents[i]!;
      if (['install_failed', 'pull_failed', 'server_failed'].includes(ev.kind)) { setPhase('error'); setErr(ev.reason || 'Failed'); return; }
      if (ev.kind === 'ready') { setPhase('done'); return; }
    }
  }, [bootstrapEvents, modelReady, phase]);

  const prog = [...bootstrapEvents].reverse().find(e => e.kind === 'pull_progress' && typeof e.completed === 'number');
  const phases = buildInstallPhases(bootstrapEvents);

  return (
    <StepCard eyebrow="Setting up AI" title={phase === 'done' ? 'Ready' : phase === 'error' ? 'Error' : 'Installing'} lede="Runs locally." back={{ onClick: onBack }} next={{ label: phase === 'done' ? 'Continue' : 'Working...', onClick: onContinue, disabled: phase !== 'done' }}>
      <div className="grid gap-2">{phases.map(p => <div key={p.id} className={cn('p-3 border rounded-md flex gap-3', p.state === 'pending' && 'opacity-60', p.state === 'error' && 'border-destructive/40')}><div className="mt-0.5">{p.state === 'done' ? <Check className="text-success size-4" /> : p.state === 'active' ? <Loader2 className="animate-spin text-primary size-4" /> : p.state === 'error' ? <X className="text-destructive size-4" /> : <span className="block size-2 rounded-full bg-muted-foreground/40 mt-1.5" />}</div><div className="flex-1"><div className="font-medium text-sm">{p.title}</div>{p.id === 'pull' && p.state === 'active' && prog && <Progress value={pullPercent(prog)} className="mt-2" />}</div></div>)}</div>
      {err && <Alert variant="destructive"><AlertTitle>Failed</AlertTitle><AlertDescription>{err}</AlertDescription></Alert>}
    </StepCard>
  );
}

function AudioStep({ onContinue, onBack }: any) {
  const [en, setEn] = React.useState(false), [wh, setWh] = React.useState<any>(null), [ist, setIst] = React.useState('idle'), [mic, setMic] = React.useState<any>(null), [busy, setBusy] = React.useState(false);
  const rp = React.useCallback(async () => { try { setWh(await window.beside.probeWhisper()); setMic(await window.beside.probeMicPermission()); } catch {} }, []);
  React.useEffect(() => { rp(); window.beside.detectWhisperInstaller(); }, [rp]);
  React.useEffect(() => { window.beside.onWhisperInstallProgress?.(e => { if (e.kind === 'started') setIst('running'); else if (e.kind === 'finished') { setIst(e.available ? 'finished' : 'failed'); rp(); } else if (e.kind === 'failed') setIst('failed'); }); }, [rp]);

  const commit = async (v: boolean) => { setBusy(true); try { if (v && mic?.status === 'not-determined') setMic(await window.beside.requestMicPermission()); await window.beside.saveConfigPatch({ capture: { ...(v ? { plugin: 'native' } : {}), capture_audio: v, audio: { live_recording: { enabled: v, activation: 'other_process_input', poll_interval_sec: 3 } } } }); setEn(v); if (v && wh && !wh.available && ist === 'idle') { setIst('running'); await window.beside.installWhisper().catch(() => setIst('failed')); } } finally { setBusy(false); } };

  return (
    <StepCard eyebrow="Optional" title="Audio capture" lede="Record short microphone chunks locally." back={{ onClick: onBack }} next={{ label: en ? 'Continue' : 'Skip', onClick: onContinue, variant: en ? 'default' : 'outline' }}>
      <div className="p-4 border rounded-xl flex gap-4"><div className="size-10 bg-primary/10 text-primary grid place-items-center rounded-md"><Mic className="size-5" /></div><div className="flex-1"><h3 className="font-medium">Capture audio privately</h3></div><Button onClick={() => commit(!en)} disabled={busy}>{busy ? <Loader2 className="animate-spin" /> : en ? 'Turn off' : 'Turn on'}</Button></div>
    </StepCard>
  );
}

function DoneStep({ gateMet, onFinish, onInstallModel, onGoToPermissions }: any) {
  const ready = gateMet.screen && gateMet.model;
  return (
    <Card className="overflow-hidden py-0"><CardContent className="p-0">
      <div className="border-b bg-muted/20 px-6 py-8 text-center"><div className="mx-auto size-16 bg-primary/10 text-primary grid place-items-center rounded-2xl"><Rocket className="size-9" /></div><h1 className="mt-5 text-3xl font-semibold">{ready ? "You're all set" : 'Almost there'}</h1></div>
      <div className="flex flex-col gap-6 p-6 sm:p-8"><div className="flex justify-center">{ready ? <Button size="xl" onClick={onFinish}>Open Beside<ArrowRight /></Button> : !gateMet.screen ? <Button size="xl" onClick={onGoToPermissions}>Grant Screen Recording<ArrowRight /></Button> : <Button size="xl" onClick={onInstallModel}>Install local AI<ArrowRight /></Button>}</div></div>
    </CardContent></Card>
  );
}
