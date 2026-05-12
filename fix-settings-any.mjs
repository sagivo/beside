import fs from 'fs/promises';

async function main() {
  let text = await fs.readFile('packages/desktop/src/renderer/src/screens/Settings.tsx', 'utf8');

  // Fix implicit any `onChange={v => ` and `onChange={(v) => `
  text = text.replace(/onChange=\{v => /g, 'onChange={(v: any) => ');
  text = text.replace(/onChange=\{\(v\) => /g, 'onChange={(v: any) => ');

  await fs.writeFile('packages/desktop/src/renderer/src/screens/Settings.tsx', text, 'utf8');
  console.log('Done fixing any');
}

main().catch(console.error);
