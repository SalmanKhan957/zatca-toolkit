#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { configFromEnv, createServer } from './server.js';

const server = createServer(configFromEnv());
await server.connect(new StdioServerTransport());
// Logs must go to stderr: stdout carries the MCP protocol.
console.error('zatca-toolkit MCP server running on stdio');
