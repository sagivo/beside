/**
 * One-shot MCP Streamable HTTP check against a running CofounderOS server.
 * Run: node scripts/verify-http-client.mjs [baseUrl]
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const base = process.argv[2] ?? 'http://localhost:3456/';
const url = new URL(base.endsWith('/') ? base : `${base}/`);

const client = new Client({ name: 'verify-http-client', version: '0.0.1' });
const transport = new StreamableHTTPClientTransport(url);

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  console.log('OK list_tools', tools.length, 'tools');
  const names = tools.map((t) => t.name).sort();
  if (!names.includes('search_memory')) {
    console.error('FAIL missing search_memory', names);
    process.exitCode = 1;
  } else {
    const out = await client.callTool({
      name: 'search_memory',
      arguments: { query: 'test', limit: 1 },
    });
    const text = out.content?.find((c) => c.type === 'text')?.text ?? '';
    console.log('OK call_tool search_memory', text.slice(0, 200).replace(/\n/g, ' '));
  }
} catch (e) {
  console.error('FAIL', e);
  process.exitCode = 1;
} finally {
  await transport.close().catch(() => {});
}
