import {readFileSync} from 'node:fs';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import {STATUS_MAX} from '../spec.ts';
import {TakeTracker,listTakes,readTake,setStatus,type Take} from './inbox.ts';

const INSTRUCTIONS=`jXRvis: a player in a VR/MR headset speaks feedback about the running app; each take arrives as a folder with their eye view, voice, transcript and app context.
Live mode: call next_feedback in a loop. For each take, set_status "On it: <what you understood>" first, then fix it, then "Done: <what changed>, reload to see" (or "Skipped: <why>").
Small, safe fixes go in without asking. Large, risky or ambiguous ones: set_status "Question: <short question>", ask in your chat too, and wait.
Keep each status under ${STATUS_MAX} characters: it is shown and read aloud in the headset. At the end, write a fix note listing each take and what was done.
A take with "replyTo" is the player's spoken answer to your Question on that take: continue on the asking take (set_status on the replyTo id, which the headset follows) and mark the answer take "Done: answer to <id>".`;

const summary=(take:Take)=>({
  id:take.id,
  transcript:take.transcript,
  summary:take.summary,
  status:take.status,
  finished:take.finished,
  ...(take.replyTo?{replyTo:take.replyTo,question:take.question}:{}),
  folder:take.folder,
  view:take.view,
  voice:take.voice,
});

function content(take:Take,includeView:boolean,root:string){
  const asking=take.replyTo?readTake(root,take.replyTo):null;
  const reply=take.replyTo?{
    answers:asking?{id:asking.id,transcript:asking.transcript,summary:asking.summary,statusLines:asking.statusLines}:{id:take.replyTo,missing:true},
    next:`This is the player's answer to your question on ${take.replyTo}. Continue there: set_status on ${take.replyTo}. Mark this take "Done: answer to ${take.replyTo}".`,
  }:{};
  const parts:({type:'text';text:string}|{type:'image';data:string;mimeType:string})[]=[
    {type:'text',text:JSON.stringify({...summary(take),...reply,statusLines:take.statusLines,context:take.context},null,2)},
  ];
  if(includeView&&take.view){
    try{parts.push({type:'image',data:readFileSync(take.view).toString('base64'),mimeType:take.view.endsWith('.png')?'image/png':'image/jpeg'});}catch{}
  }
  return parts;
}

/**
 * An MCP server (any transport) over one inbox: next_feedback, list_feedback, get_feedback, set_status.
 * `next_feedback` hands out each take once, in order, starting with takes that arrive after the server
 * starts (or earlier ones without a status, with includeExisting).
 */
export function createMcpServer(root:string,{wait=60,includeExisting=false,pollMs=500,version='0.1.0'}:{wait?:number;includeExisting?:boolean;pollMs?:number;version?:string}={}){
  const tracker=new TakeTracker(root,{wait,includeExisting});
  const queue:Take[]=[];
  const server=new McpServer({name:'jxrvis',version},{instructions:INSTRUCTIONS});

  server.registerTool('next_feedback',{
    title:'Next headset feedback',
    description:'Waits for the next new feedback take from the headset and returns it: transcript, app context, file paths, and the eye view as an image. Returns {"waiting":true} if none arrives within timeout_seconds; call it again to keep watching.',
    inputSchema:{
      timeout_seconds:z.number().min(0).max(600).default(45).describe('How long to wait for a take'),
      include_view:z.boolean().default(true).describe('Attach the eye view image'),
    },
  },async({timeout_seconds,include_view},extra)=>{
    const until=Date.now()+timeout_seconds*1000;
    while(true){
      queue.push(...tracker.poll());
      const take=queue.shift();
      if(take){
        const fresh=readTake(root,take.id)??take;
        return {content:content(fresh,include_view,root)};
      }
      if(Date.now()>=until||extra.signal.aborted)break;
      await new Promise(resolve=>setTimeout(resolve,Math.min(pollMs,Math.max(0,until-Date.now()))));
    }
    return {content:[{type:'text',text:JSON.stringify({waiting:true,inbox:root,pending:tracker.pending})}]};
  });

  server.registerTool('list_feedback',{
    title:'List headset feedback',
    description:'Lists feedback takes in the inbox, newest first, with transcript and current status.',
    inputSchema:{
      pending_only:z.boolean().default(false).describe('Only takes no agent has answered yet'),
      limit:z.number().int().min(1).max(200).default(20),
    },
    annotations:{readOnlyHint:true},
  },async({pending_only,limit})=>({
    content:[{type:'text',text:JSON.stringify(listTakes(root,{pending:pending_only,limit}).map(summary),null,2)}],
  }));

  server.registerTool('get_feedback',{
    title:'Get one headset take',
    description:'Returns one take by id: transcript, context, status history, file paths and the eye view.',
    inputSchema:{id:z.string(),include_view:z.boolean().default(true)},
    annotations:{readOnlyHint:true},
  },async({id,include_view})=>{
    const take=readTake(root,id);
    if(!take)return {isError:true,content:[{type:'text',text:`No take "${id}" in ${root}`}]};
    return {content:content(take,include_view,root)};
  });

  server.registerTool('set_status',{
    title:'Answer in the headset',
    description:`Writes a status line the player sees in the headset as "<agent>: <text>". Start with "On it:", "Question:", "Done:" or "Skipped:". Keep it under ${STATUS_MAX} characters. Done and Skipped end the take.`,
    inputSchema:{id:z.string(),text:z.string().min(4),replace:z.boolean().default(false).describe('Replace the history instead of appending')},
  },async({id,text,replace})=>{
    try{
      const {line,warning}=setStatus(root,id,text,{replace});
      return {content:[{type:'text',text:JSON.stringify({id,status:line,...(warning?{warning}:{})})}]};
    }catch(error){return {isError:true,content:[{type:'text',text:(error as Error).message}]};}
  });

  return server;
}
