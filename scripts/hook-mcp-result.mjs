#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MCP_CODEX_TOOL, MCP_REPLY_TOOL, completeMcpToolCall } from './lib/mcp-adapter.mjs';
import { rootFromHookInput } from './lib/paths.mjs';

async function readInput() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new Error('hook input is too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

export async function processMcpHook(input, env = process.env) {
  if (![MCP_CODEX_TOOL, MCP_REPLY_TOOL].includes(input?.tool_name)) return { handled: false };
  const root = await rootFromHookInput(input, env);
  const failed = input.hook_event_name === 'PostToolUseFailure';
  const response = failed ? (input.error ?? input.tool_response ?? {}) : input.tool_response;
  const result = await completeMcpToolCall(root, {
    toolName: input.tool_name,
    toolInput: input.tool_input,
    toolResponse: response,
    failed
  }, env);
  return { handled: true, result };
}

export async function main() {
  let hookEventName = 'PostToolUse';
  try {
    const input = await readInput();
    hookEventName = input.hook_event_name ?? hookEventName;
    const handled = await processMcpHook(input, process.env);
    const additionalContext = !handled.handled ? null
      : handled.result.ok ? `Fabex verified Codex MCP thread ${handled.result.threadId}.`
        : handled.result.confirmedMissing ? 'Fabex recorded the Codex thread as definitively unavailable; one checkpoint-seeded replacement is authorized.'
          : 'Fabex recorded an interrupted Codex MCP operation and entered recovery-read-only.';
    process.stdout.write(additionalContext
      ? `${JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext } })}\n`
      : '{}\n');
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: `Fabex could not verify the Codex MCP result: ${error.message}. Remain recovery-read-only and use /fabex:recover.` } })}\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
