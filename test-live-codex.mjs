import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

if (!process.env.DEEPSEEK_API_KEY && !process.env.HOUTINI_LM_API_KEY) {
  throw new Error('Set DEEPSEEK_API_KEY or HOUTINI_LM_API_KEY');
}

const projectRoot = path.resolve('..');
const outputPath = path.join(projectRoot, 'build/delegated/live-delegate-smoke.txt');
await rm(outputPath, { force: true });

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['dist/index.js'],
  env: {
    ...process.env,
    HOUTINI_LM_ENDPOINT_URL: 'https://api.deepseek.com',
    HOUTINI_LM_PROVIDER: 'deepseek',
    HOUTINI_LM_MODEL: 'deepseek-v4-pro',
    HOUTINI_LM_ORCHESTRATOR: 'codex',
    HOUTINI_LM_DEEPSEEK_THINKING: 'auto',
    HOUTINI_LM_AUTO_MAX_TOKENS: '3000',
    HOUTINI_LM_RESPONSE_METADATA: 'none',
    HOUTINI_LM_ALLOWED_ROOTS: projectRoot,
  },
  stderr: 'pipe',
});
const client = new Client({ name: 'houtini-live-test', version: '1.0.0' });

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const delegate = tools.tools.find((tool) => tool.name === 'delegate');
  assert(delegate);
  assert(delegate.inputSchema.properties.output_path);
  assert(delegate.inputSchema.properties.max_chars);

  const result = await client.callTool({
    name: 'delegate',
    arguments: {
      task: 'Return one concise sentence identifying the only risk in the input.',
      content: 'A generated BOM has not been compared with the frozen PCB designators.',
      kind: 'review',
      max_tokens: 120,
      max_chars: 300,
      thinking: 'enabled',
      output_path: outputPath,
    },
  });
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /Saved delegated output/);
  const artifact = await readFile(outputPath, 'utf8');
  assert(artifact.length > 0 && artifact.length <= 300);
  console.log(`Live Codex delegate smoke test passed: ${artifact}`);
} finally {
  await client.close();
  await rm(outputPath, { force: true });
}
