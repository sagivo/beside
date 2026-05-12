import * as React from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { HelpCircle, Power, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

export function SettingsSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        <div>
          <h3 className="text-sm font-semibold">{title}</h3>
          {description ? (
            <p className="mt-1 text-sm text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

function InfoTip({ content }: { content: string }) {
  const [open, setOpen] = React.useState(false);
  const [pinned, setPinned] = React.useState(false);
  const lines = content.split('\n').filter(Boolean);

  function setPinnedOpen(next: boolean) {
    setPinned(next);
    setOpen(next);
  }

  return (
    <TooltipPrimitive.Provider delayDuration={120} skipDelayDuration={0}>
      <TooltipPrimitive.Root
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setPinned(false);
        }}
      >
        <TooltipPrimitive.Trigger asChild>
          <button
            type="button"
            className="inline-flex size-5 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            aria-label="Show setting help"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setPinnedOpen(!pinned);
            }}
            onPointerEnter={() => setOpen(true)}
            onPointerLeave={() => {
              if (!pinned) setOpen(false);
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => {
              if (!pinned) setOpen(false);
            }}
          >
            <HelpCircle className="size-3.5" />
          </button>
        </TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side="top"
            align="start"
            sideOffset={7}
            collisionPadding={12}
            className="z-50 max-w-72 rounded-md border bg-popover px-3 py-2 text-xs leading-relaxed text-popover-foreground shadow-md"
          >
            {lines.map((line, index) => (
              <div
                key={`${line}-${index}`}
                className={cn(index > 0 && 'mt-1 text-muted-foreground')}
              >
                {line}
              </div>
            ))}
            <TooltipPrimitive.Arrow className="fill-popover" />
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}

function Field({
  label,
  hint,
  typeLabel,
  rangeLabel,
  children,
}: {
  label: string;
  hint?: string;
  typeLabel?: string;
  rangeLabel?: string;
  children: React.ReactNode;
}) {
  const tooltip = [
    hint,
    typeLabel ? `Type: ${typeLabel}` : null,
    rangeLabel ? `Range: ${rangeLabel}` : null,
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex min-h-5 flex-wrap items-center gap-2">
        <Label>{label}</Label>
        {typeLabel ? (
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.04em] text-muted-foreground">
            {typeLabel}
          </span>
        ) : null}
        {rangeLabel ? (
          <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {rangeLabel}
          </span>
        ) : null}
        {tooltip ? <InfoTip content={tooltip} /> : null}
      </div>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function TextField({
  label,
  value,
  onChange,
  hint,
  typeLabel,
  placeholder,
  inputType = 'text',
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  typeLabel?: string;
  placeholder?: string;
  inputType?: React.HTMLInputTypeAttribute;
}) {
  return (
    <Field label={label} hint={hint} typeLabel={typeLabel}>
      <Input
        type={inputType}
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        placeholder={placeholder}
        autoComplete={inputType === 'password' ? 'off' : undefined}
        spellCheck={false}
      />
    </Field>
  );
}

export function TextAreaField({
  label,
  value,
  onChange,
  hint,
  typeLabel,
  placeholder,
  rows = 4,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  typeLabel?: string;
  placeholder?: string;
  rows?: number;
}) {
  return (
    <Field label={label} hint={hint} typeLabel={typeLabel}>
      <Textarea
        rows={rows}
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        placeholder={placeholder}
        spellCheck={false}
      />
    </Field>
  );
}

export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step,
  unit,
  hint,
  typeLabel,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  hint?: string;
  typeLabel?: string;
}) {
  return (
    <Field
      label={label}
      hint={hint}
      typeLabel={typeLabel}
      rangeLabel={formatRange(min, max, unit)}
    >
      <Input
        type="number"
        min={min}
        max={max}
        step={step}
        value={Number.isFinite(value) ? value : ''}
        onChange={(e) => {
          const raw = e.currentTarget.value;
          onChange(raw.trim() === '' ? (min ?? 0) : Number(raw));
        }}
      />
    </Field>
  );
}

export function OptionalNumberField({
  label,
  value,
  onChange,
  min,
  max,
  step,
  unit,
  hint,
  typeLabel,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  hint?: string;
  typeLabel?: string;
}) {
  return (
    <Field
      label={label}
      hint={hint}
      typeLabel={typeLabel}
      rangeLabel={formatRange(min, max, unit)}
    >
      <Input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        placeholder="blank"
      />
    </Field>
  );
}

export function SelectField({
  label,
  value,
  onChange,
  options,
  hint,
  typeLabel,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  hint?: string;
  typeLabel?: string;
}) {
  return (
    <Field label={label} hint={hint} typeLabel={typeLabel}>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

function formatRange(min?: number, max?: number, unit?: string): string | undefined {
  if (min == null && max == null) return unit;
  const body =
    min != null && max != null
      ? `${min}-${max}`
      : min != null
        ? `>= ${min}`
        : `<= ${max}`;
  return unit ? `${body} ${unit}` : body;
}

export function ToggleRow({
  title,
  description,
  typeLabel,
  checked,
  onChange,
}: {
  title: string;
  description: string;
  typeLabel?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="font-medium">{title}</h4>
          {typeLabel ? (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.04em] text-muted-foreground">
              {typeLabel}
            </span>
          ) : null}
          <InfoTip content={`Type: ${typeLabel ?? 'boolean'}\n${description}`} />
        </div>
        <p className="text-sm text-muted-foreground mt-0.5">{description}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

export function SaveBar({
  hasUnsavedChanges,
  saving,
  onSave,
  onSaveAndRestart,
  onReset,
}: {
  hasUnsavedChanges: boolean;
  saving: boolean;
  onSave: () => void;
  onSaveAndRestart: () => void;
  onReset: () => void;
}) {
  if (!hasUnsavedChanges) return null;
  return (
    <div
      className="fixed bottom-4 right-4 z-30 mx-auto max-w-2xl pl-4 animate-in fade-in-0 slide-in-from-bottom-3"
      style={{ left: 'var(--sidebar-w, 15rem)' }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-popover px-4 py-3 shadow-lg">
        <p className="text-sm">
          You have unsaved changes.{' '}
          <span className="text-muted-foreground">Some take effect on next start.</span>
        </p>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onReset} disabled={saving}>
            Reset
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onSaveAndRestart}
            disabled={saving}
            title="Save and restart the runtime so changes apply now"
          >
            <Power />
            {saving ? 'Working...' : 'Save & restart'}
          </Button>
          <Button size="sm" onClick={onSave} disabled={saving}>
            <Save />
            {saving ? 'Saving...' : 'Save'}
          </Button>
        </div>
      </div>
    </div>
  );
}
