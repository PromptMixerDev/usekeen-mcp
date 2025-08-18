#!/usr/bin/env node

// Minimal CLI to spawn the local MCP server and call its tool
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseArgs(argv) {
  const args = { query: '' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--package' || a === '-p') {
      args.package_name = argv[++i];
    } else if (a === '--query' || a === '-q') {
      args.query = argv[++i] ?? '';
    } else if (!args.package_name) {
      // positional first arg as package name
      args.package_name = a;
    } else if (!args.query) {
      // positional second arg as query
      args.query = a;
    }
  }
  return args;
}

async function main() {
  const { package_name, query } = parseArgs(process.argv);
  if (!package_name) {
    console.error('Usage: node scripts/test-cli.mjs --package <name> [--query <q>]');
    process.exit(2);
  }
  const apiKey = process.env.USEKEEN_API_KEY;
  if (!apiKey) {
    console.error('Missing USEKEEN_API_KEY in environment');
    process.exit(1);
  }

  const distPath = path.resolve(__dirname, '..', 'dist', 'index.js');

  const client = new Client({ name: 'UseKeen Test CLI', version: '0.0.0' });
  client.registerCapabilities({ tools: {} });

  const transport = new StdioClientTransport({
    command: 'node',
    args: [distPath],
    env: { USEKEEN_API_KEY: apiKey },
    stderr: 'inherit',
  });

  try {
    await client.connect(transport);

    // Optional: list tools
    const tools = await client.listTools();
    const hasTool = tools.tools.some(t => t.name === 'usekeen_package_doc_search');
    if (!hasTool) {
      throw new Error('Server did not register expected tool: usekeen_package_doc_search');
    }

    const result = await client.callTool({
      name: 'usekeen_package_doc_search',
      arguments: { package_name, query: query || '' },
    });

    // Show content blocks first, then raw structured payload for inspection
    if (Array.isArray(result.content) && result.content.length) {
      const textBlocks = result.content.filter(c => c.type === 'text');
      console.log(textBlocks.map((b, i) => `--- content[${i}] ---\n${b.text}`).join('\n\n'));
    }
    if (result.structuredContent) {
      console.log('\n--- structuredContent ---');
      console.log(JSON.stringify(result.structuredContent, null, 2));
    }
  } finally {
    await transport.close();
  }
}

main().catch((err) => {
  console.error('Test CLI failed:', err?.message || err);
  process.exit(1);
});
