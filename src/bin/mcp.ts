#!/usr/bin/env node
// jXRvis MCP server over stdio: next_feedback, list_feedback, get_feedback, set_status on one inbox.
//   jxrvis-mcp [--inbox feedback/inbox] [--wait 60] [--include-existing]
import {resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {DEFAULT_INBOX} from '../spec.ts';
import {createMcpServer} from '../agent/mcp.ts';

const {values}=parseArgs({options:{
  inbox:{type:'string'},wait:{type:'string',default:'60'},'include-existing':{type:'boolean',default:false},
}});
// Relative to where the agent starts the server: normally the project root.
const inbox=resolve(values.inbox??process.env.JXRVIS_INBOX??DEFAULT_INBOX);
const server=createMcpServer(inbox,{wait:Number(values.wait),includeExisting:values['include-existing']});
await server.connect(new StdioServerTransport());
console.error(`jXRvis MCP server on ${inbox}`);
