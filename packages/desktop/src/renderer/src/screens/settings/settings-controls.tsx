import * as React from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { HelpCircle, Power, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

export function SettingsSection({ title, description, children }: { title: string; description?: string; children: React.ReactNode; }) {
  return <Card><CardContent className="flex flex-col gap-4"><div><h3 className="text-sm font-semibold">{title}</h3>{description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}</div>{children}</CardContent></Card>;
}

function InfoTip({ content }: { content: string }) {
  const [open, setOpen] = React.useState(false), [pinned, setPinned] = React.useState(false);
  return (
    <TooltipPrimitive.Provider delayDuration={120} skipDelayDuration={0}>
      <TooltipPrimitive.Root open={open} onOpenChange={n => { setOpen(n); if (!n) setPinned(false); }}>
        <TooltipPrimitive.Trigger asChild>
          <button type="button" className="inline-flex size-5 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground" onClick={e => { e.preventDefault(); e.stopPropagation(); setPinned(!pinned); setOpen(!pinned); }} onPointerEnter={() => setOpen(true)} onPointerLeave={() => { if (!pinned) setOpen(false); }} onFocus={() => setOpen(true)} onBlur={() => { if (!pinned) setOpen(false); }}>
            <HelpCircle className="size-3.5" />
          </button>
        </TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content side="top" align="start" sideOffset={7} collisionPadding={12} className="z-50 max-w-72 rounded-md border bg-popover px-3 py-2 text-xs leading-relaxed text-popover-foreground shadow-md">
            {content.split('\n').filter(Boolean).map((l, i) => <div key={i} className={cn(i > 0 && 'mt-1 text-muted-foreground')}>{l}</div>)}
            <TooltipPrimitive.Arrow className="fill-popover" />
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}

function Field({ label, hint, typeLabel, rangeLabel, children }: any) {
  const tt = [hint, typeLabel ? `Type: ${typeLabel}` : null, rangeLabel ? `Range: ${rangeLabel}` : null].filter(Boolean).join('\n');
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex min-h-5 flex-wrap items-center gap-2"><Label>{label}</Label>{typeLabel && <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">{typeLabel}</span>}{rangeLabel && <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">{rangeLabel}</span>}{tt && <InfoTip content={tt} />}</div>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function TextField({ label, value, onChange, hint, typeLabel, placeholder, inputType = 'text' }: any) {
  return <Field label={label} hint={hint} typeLabel={typeLabel}><Input type={inputType} value={value} onChange={e => onChange(e.currentTarget.value)} placeholder={placeholder} autoComplete={inputType === 'password' ? 'off' : undefined} spellCheck={false} /></Field>;
}

export function TextAreaField({ label, value, onChange, hint, typeLabel, placeholder, rows = 4 }: any) {
  return <Field label={label} hint={hint} typeLabel={typeLabel}><Textarea rows={rows} value={value} onChange={e => onChange(e.currentTarget.value)} placeholder={placeholder} spellCheck={false} /></Field>;
}

export function NumberField({ label, value, onChange, min, max, step, unit, hint, typeLabel }: any) {
  return <Field label={label} hint={hint} typeLabel={typeLabel} rangeLabel={formatRange(min, max, unit)}><Input type="number" min={min} max={max} step={step} value={Number.isFinite(value) ? value : ''} onChange={e => { const r = e.currentTarget.value; onChange(r.trim() === '' ? (min ?? 0) : Number(r)); }} /></Field>;
}

export function OptionalNumberField({ label, value, onChange, min, max, step, unit, hint, typeLabel }: any) {
  return <Field label={label} hint={hint} typeLabel={typeLabel} rangeLabel={formatRange(min, max, unit)}><Input type="number" min={min} max={max} step={step} value={value} onChange={e => onChange(e.currentTarget.value)} placeholder="blank" /></Field>;
}

export function SelectField({ label, value, onChange, options, hint, typeLabel }: any) {
  return <Field label={label} hint={hint} typeLabel={typeLabel}><Select value={value} onValueChange={onChange}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{options.map((o: any) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent></Select></Field>;
}

function formatRange(min?: number, max?: number, unit?: string) {
  if (min == null && max == null) return unit;
  const b = min != null && max != null ? `${min}-${max}` : min != null ? `>= ${min}` : `<= ${max}`;
  return unit ? `${b} ${unit}` : b;
}

export function ToggleRow({ title, description, typeLabel, checked, onChange }: any) {
  return <div className="flex items-center justify-between gap-4"><div><div className="flex items-center gap-2"><h4 className="font-medium">{title}</h4>{typeLabel && <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">{typeLabel}</span>}<InfoTip content={`Type: ${typeLabel ?? 'boolean'}\n${description}`} /></div><p className="text-sm text-muted-foreground mt-0.5">{description}</p></div><Switch checked={checked} onCheckedChange={onChange} /></div>;
}

export function SaveBar({ hasUnsavedChanges, saving, onSave, onSaveAndRestart, onReset }: any) {
  if (!hasUnsavedChanges) return null;
  return (
    <div className="fixed bottom-4 right-4 z-30 mx-auto max-w-2xl pl-4 animate-in fade-in-0 slide-in-from-bottom-3" style={{ left: 'var(--sidebar-w, 15rem)' }}>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-popover px-4 py-3 shadow-lg">
        <p className="text-sm">You have unsaved changes. <span className="text-muted-foreground">Some take effect on next start.</span></p>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onReset} disabled={saving}>Reset</Button>
          <Button variant="outline" size="sm" onClick={onSaveAndRestart} disabled={saving}><Power />{saving ? 'Working...' : 'Save & restart'}</Button>
          <Button size="sm" onClick={onSave} disabled={saving}><Save />{saving ? 'Saving...' : 'Save'}</Button>
        </div>
      </div>
    </div>
  );
}
