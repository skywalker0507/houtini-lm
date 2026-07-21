import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const requests = [];
let nextContent = 'concise result';
const scriptedResponses = [];

const upstream = http.createServer(async (req, res) => {
  if (req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'deepseek-v4-flash' }] }));
    return;
  }

  let raw = '';
  for await (const chunk of req) raw += chunk;
  requests.push(JSON.parse(raw));
  const scripted = scriptedResponses.shift();
  const delta = scripted?.reasoningOnly
    ? { reasoning_content: scripted.reasoning || 'hidden reasoning' }
    : { content: scripted?.content ?? nextContent };
  const finishReason = scripted?.finishReason ?? 'stop';
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(
    `data: ${JSON.stringify({
      model: 'deepseek-v4-flash',
      choices: [{ delta, finish_reason: finishReason }],
      usage: {
        prompt_tokens: 20,
        completion_tokens: scripted?.completionTokens ?? 3,
        total_tokens: 23,
        completion_tokens_details: scripted?.reasoningOnly
          ? { reasoning_tokens: scripted?.completionTokens ?? 3 }
          : undefined,
      },
    })}\n\ndata: [DONE]\n\n`,
  );
});

await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${upstream.address().port}`;

async function connect(orchestrator, extraEnv = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['dist/index.js'],
    env: {
      ...process.env,
      HOUTINI_LM_ENDPOINT_URL: endpoint,
      HOUTINI_LM_PROVIDER: 'deepseek',
      HOUTINI_LM_MODEL: 'deepseek-v4-flash',
      HOUTINI_LM_ORCHESTRATOR: orchestrator,
      HOUTINI_LM_AUTO_MAX_TOKENS: '100',
      HOUTINI_LM_RESPONSE_METADATA: 'compact',
      HOUTINI_LM_ALLOWED_ROOTS: process.cwd(),
      ...extraEnv,
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'houtini-test', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

try {
  const codex = await connect('codex');
  const listed = await codex.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name), ['delegate']);
  assert.match(codex.getInstructions() || '', /Keep architecture.*final decisions.*Codex/);

  const delegated = await codex.callTool({
    name: 'delegate',
    arguments: {
      task: 'Explain the input briefly',
      content: 'some large input',
      kind: 'explain',
      max_tokens: 800,
    },
  });
  assert.equal(delegated.isError, undefined);
  assert.equal(delegated.content[0].text, 'concise result');
  assert.equal(requests.at(-1).max_tokens, 100);
  assert.equal(requests.at(-1).max_completion_tokens, undefined);
  assert.deepEqual(requests.at(-1).thinking, { type: 'disabled' });

  nextContent = 'reasoned result';
  const reasoned = await codex.callTool({
    name: 'delegate',
    arguments: {
      task: 'Review the input carefully',
      content: 'bounded input',
      kind: 'review',
      max_tokens: 80,
      thinking: 'enabled',
      model: 'deepseek-v4-pro',
    },
  });
  assert.equal(reasoned.isError, undefined);
  assert.equal(reasoned.content[0].text, 'reasoned result');
  assert.deepEqual(requests.at(-1).thinking, { type: 'enabled' });
  assert.equal(requests.at(-1).reasoning_effort, 'high');
  assert.equal(requests.at(-1).model, 'deepseek-v4-pro');

  const resilient = await connect('codex', {
    HOUTINI_LM_AUTO_MAX_TOKENS: '2000',
    HOUTINI_LM_DEEPSEEK_THINKING: 'auto',
  });
  scriptedResponses.push(
    { reasoningOnly: true, finishReason: 'length', completionTokens: 1104 },
    { content: 'recovered visible answer' },
  );
  const recovered = await resilient.callTool({
    name: 'delegate',
    arguments: {
      task: 'Review the input carefully',
      content: 'bounded input',
      kind: 'review',
      max_tokens: 80,
    },
  });
  assert.equal(recovered.isError, undefined);
  assert.equal(recovered.content[0].text, 'recovered visible answer');
  assert.equal(requests.at(-2).max_tokens, 1104);
  assert.deepEqual(requests.at(-2).thinking, { type: 'enabled' });
  assert.equal(requests.at(-1).max_tokens, 80);
  assert.deepEqual(requests.at(-1).thinking, { type: 'disabled' });

  const outputPath = path.resolve('houtini-delegate-test.txt');
  await rm(outputPath, { force: true });
  scriptedResponses.push({ content: 'saved artifact' });
  const saved = await resilient.callTool({
    name: 'delegate',
    arguments: {
      task: 'Draft a small artifact',
      content: 'bounded input',
      kind: 'draft',
      output_path: outputPath,
    },
  });
  assert.equal(saved.isError, undefined);
  assert.match(saved.content[0].text, /Saved delegated output/);
  assert.equal(await readFile(outputPath, 'utf8'), 'saved artifact');
  await rm(outputPath, { force: true });
  await resilient.close();

  if (process.platform === 'win32') {
    const blocked = await codex.callTool({
      name: 'delegate',
      arguments: {
        task: 'Summarize this file',
        paths: ['C:\\Windows\\win.ini'],
        kind: 'summarize',
      },
    });
    assert.equal(blocked.isError, true);
    assert.match(blocked.content[0].text, /outside HOUTINI_LM_ALLOWED_ROOTS/);
  }
  await codex.close();

  const fileBounded = await connect('codex', {
    HOUTINI_LM_MAX_FILE_MB: '1',
  });
  const oversizedPath = path.resolve('houtini-oversized-delegate-input.txt');
  await writeFile(oversizedPath, 'x'.repeat(1024 * 1024 + 1), 'utf8');
  try {
    const oversizedFile = await fileBounded.callTool({
      name: 'delegate',
      arguments: {
        task: 'Summarize this file',
        paths: [oversizedPath],
        kind: 'summarize',
      },
    });
    assert.equal(oversizedFile.isError, true);
    assert.match(oversizedFile.content[0].text, /refusing partial delegation/);
    assert.match(oversizedFile.content[0].text, /over the 1 MB limit/);
  } finally {
    await rm(oversizedPath, { force: true });
    await fileBounded.close();
  }

  const capped = await connect('codex');
  scriptedResponses.push(
    { content: 'this initial result is intentionally too long' },
    { content: 'this compression result is still too long' },
  );
  const failedCompression = await capped.callTool({
    name: 'delegate',
    arguments: {
      task: 'Summarize this input',
      content: 'bounded input',
      kind: 'summarize',
      max_chars: 10,
    },
  });
  assert.equal(failedCompression.isError, true);
  assert.match(failedCompression.content[0].text, /compression could not satisfy max_chars=10/);
  assert.doesNotMatch(failedCompression.content[0].text, /intentionally too long/);
  await capped.close();

  const projectMode = await connect('codex', {
    HOUTINI_LM_DEEPSEEK_THINKING: 'enabled',
    HOUTINI_LM_MAX_INPUT_CHARS: '100',
  });
  nextContent = 'project result';
  const projectDelegated = await projectMode.callTool({
    name: 'delegate',
    arguments: {
      task: 'Review briefly',
      content: 'short',
      kind: 'review',
    },
  });
  assert.equal(projectDelegated.isError, undefined);
  assert.deepEqual(requests.at(-1).thinking, { type: 'enabled' });

  const oversized = await projectMode.callTool({
    name: 'delegate',
    arguments: {
      task: 'Review briefly',
      content: 'x'.repeat(200),
      kind: 'review',
    },
  });
  assert.equal(oversized.isError, true);
  assert.match(oversized.content[0].text, /HOUTINI_LM_MAX_INPUT_CHARS=100/);
  await projectMode.close();

  const generic = await connect('generic');
  nextContent = '{"answer":"ok"}';
  const jsonResult = await generic.callTool({
    name: 'chat',
    arguments: {
      message: 'Return JSON',
      json_schema: {
        name: 'result',
        schema: {
          type: 'object',
          properties: { answer: { type: 'string' } },
          required: ['answer'],
        },
      },
    },
  });
  assert.equal(jsonResult.isError, undefined);
  assert.equal(jsonResult.content[0].text, '{"answer":"ok"}');
  assert.deepEqual(requests.at(-1).response_format, { type: 'json_object' });
  await generic.close();

  const autoThinking = await connect('generic', { HOUTINI_LM_DEEPSEEK_THINKING: 'auto' });
  nextContent = 'answer';
  await autoThinking.callTool({
    name: 'chat',
    arguments: { message: 'Review this design' },
  });
  assert.deepEqual(requests.at(-1).thinking, { type: 'enabled' });
  assert.equal(requests.at(-1).reasoning_effort, 'high');
  assert.equal(requests.at(-1).temperature, undefined);
  await autoThinking.close();

  console.log('Codex/DeepSeek regression tests passed.');
} finally {
  upstream.close();
}
