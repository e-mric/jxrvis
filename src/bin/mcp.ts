#!/usr/bin/env node
// jXRvis MCP server over stdio: next_feedback, list_feedback, get_feedback, set_status on one inbox.
//   jxrvis-mcp [--inbox feedback/inbox] [--wait 60] [--include-existing]
import {resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {DEFAULT_INBOX} from '../spec.ts';
import {createMcpServer} from '../agent/mcp.ts';

const {values}=parseArgs({options:{
  inbox:{type:'string'},wait:{type:'string',default:'60'},'include-existing':{type:'boolean',default:false},help:{type:'boolean',short:'h'},
}});
if(values.help){
  console.log(`jxrvis-mcp: MCP server (stdio) over a jXRvis inbox. Tools: next_feedback, list_feedback, get_feedback, set_status.

  --inbox <dir>         the inbox folder (default ${DEFAULT_INBOX}, or $JXRVIS_INBOX), relative to where it starts
  --wait <s>            how long next_feedback waits for a transcript that has not come (default 60)
  --include-existing    next_feedback also hands out earlier takes that have no status yet

Register it with your agent, e.g.: claude mcp add jxrvis -- npx jxrvis-mcp --inbox feedback/inbox`);
  process.exit(0);
}
// Relative to where the agent starts the server: normally the project root.
const inbox=resolve(values.inbox??process.env.JXRVIS_INBOX??DEFAULT_INBOX);
const server=createMcpServer(inbox,{wait:Number(values.wait),includeExisting:values['include-existing']});
await server.connect(new StdioServerTransport());
console.error(`jXRvis MCP server on ${inbox}`);
