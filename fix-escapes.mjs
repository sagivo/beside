import fs from 'fs/promises';

async function fixFile(file) {
  try {
    let content = await fs.readFile(file, 'utf-8');
    const original = content;

    // Replace escaped backticks
    content = content.replace(/\\`/g, '`');
    // Replace escaped interpolation
    content = content.replace(/\\\$\{/g, '${');
    // Replace double backslashes before regex/string metacharacters
    content = content.replace(/\\\\([nrtbdsSwW/.+?*\(\)\[\]{}|^$-])/g, '\\$1');

    if (content !== original) {
      await fs.writeFile(file, content, 'utf-8');
      console.log('Fixed', file);
    }
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.error(e);
    }
  }
}

async function main() {
  const files = process.argv.slice(2);
  for (const file of files) {
    await fixFile(file);
  }
}

main().catch(console.error);
