import fs from 'fs/promises';

async function main() {
  let text = await fs.readFile('packages/desktop/src/renderer/src/screens/Settings.tsx', 'utf8');

  // Fix implicit any `v =>`
  text = text.replace(/([ (,])(v => )/g, '$1(v: any) => ');

  // Add resetDraft function if it's missing in Settings component
  if (!text.includes('function resetDraft() {')) {
    text = text.replace(
      /const hasUnsavedChanges = [^;]+;/,
      '$&\n  const resetDraft = () => setDraft(settingsDraftFromConfig(config!));'
    );
  }

  // Add ThemePicker component if missing
  if (!text.includes('function ThemePicker')) {
    text += `
function ThemePicker({ value, onChange }: { value: ThemePreference; onChange: (v: ThemePreference) => void }) {
  const o = [{ id: 'auto' as const, label: 'Auto', icon: <Monitor /> }, { id: 'light' as const, label: 'Light', icon: <Sun /> }, { id: 'dark' as const, label: 'Dark', icon: <Moon /> }];
  return <RadioGroup value={value} onValueChange={v => onChange(v as ThemePreference)} className="grid grid-cols-3 gap-2">{o.map(x => <Label key={x.id} className={cn('flex flex-col items-center gap-1.5 p-3 border rounded-lg cursor-pointer', value === x.id ? 'border-primary ring-2 ring-primary/20' : 'hover:bg-accent/40')}><RadioGroupItem value={x.id} className="sr-only" /><div className="size-8 grid place-items-center text-muted-foreground [&>svg]:size-4">{x.icon}</div><span className="font-medium">{x.label}</span></Label>)}</RadioGroup>;
}
`;
  }

  await fs.writeFile('packages/desktop/src/renderer/src/screens/Settings.tsx', text, 'utf8');
}

main().catch(console.error);
