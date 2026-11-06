import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,utimesSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {TakeTracker,describe,listTakes,readTake,setStatus,takeIds} from '../src/agent/inbox.ts';
import {sortIds} from '../src/spec.ts';

const PNG=Buffer.from('89504e470d0a1a0a0000000d49484452','hex');
const inbox=()=>{const root=join(mkdtempSync(join(tmpdir(),'jxrvis-agent-')),'inbox');mkdirSync(root);return root;};

function take(root:string,id:string,{transcript,voice=true,context={}}:{transcript?:string|null;voice?:boolean;context?:object}={}){
  const folder=join(root,id);mkdirSync(folder);
  writeFileSync(join(folder,'view.png'),PNG);
  writeFileSync(join(folder,'context.json'),JSON.stringify({savedAt:'x',transcriber:'whisper',...context}));
  if(voice)writeFileSync(join(folder,'voice.webm'),'opus');
  if(transcript!=null)writeFileSync(join(folder,'transcript.txt'),transcript+'\n');
  return folder;
}
const age=(file:string,seconds:number)=>{const t=new Date(Date.now()-seconds*1000);utimesSync(file,t,t);};

test('ids sort by time, then by their -N suffix, and anything else in the inbox is ignored',()=>{
  assert.deepEqual(sortIds(['2026-11-03_18-42-07-10','2026-11-03_18-42-08','2026-11-03_18-42-07-2','2026-11-03_18-42-07']),
    ['2026-11-03_18-42-07','2026-11-03_18-42-07-2','2026-11-03_18-42-07-10','2026-11-03_18-42-08']);
  const root=inbox();
  take(root,'2026-11-03_18-42-07');mkdirSync(join(root,'notes'));writeFileSync(join(root,'.gitignore'),'*');
  assert.deepEqual(takeIds(root),['2026-11-03_18-42-07']);
  assert.deepEqual(takeIds(join(root,'missing')),[]);
});

test('a take reads back with its files, transcript, summary and status history',()=>{
  const root=inbox();
  const folder=take(root,'2026-11-03_18-42-07',{transcript:'the door does not open',context:{summary:'level 3'}});
  writeFileSync(join(folder,'status.txt'),'On it: the door\nDone: door opens, reload to see\n');
  const t=readTake(root,'2026-11-03_18-42-07')!;
  assert.equal(t.view,join(folder,'view.png'));assert.equal(t.voice,join(folder,'voice.webm'));
  assert.equal(t.transcript,'the door does not open');assert.equal(t.summary,'level 3');
  assert.equal(t.status,'Done: door opens, reload to see');assert.equal(t.statusLines.length,2);assert.ok(t.finished);
  assert.equal(describe(t),'FEEDBACK 2026-11-03_18-42-07 [level 3]: the door does not open');
  assert.equal(readTake(root,'../escape'),null);assert.equal(readTake(root,'2026-11-03_18-42-08'),null);
});

test('status lines are appended (or replaced), must use one of the four prefixes, and long ones are flagged',()=>{
  const root=inbox();const folder=take(root,'2026-11-03_18-42-07',{transcript:'x'});
  setStatus(root,'2026-11-03_18-42-07','On it:   the  door\nhandle');
  setStatus(root,'2026-11-03_18-42-07','Question: lock it or remove it?');
  assert.equal(readFileSync(join(folder,'status.txt'),'utf8'),'On it: the door handle\nQuestion: lock it or remove it?\n');
  setStatus(root,'2026-11-03_18-42-07','Done: removed',{replace:true});
  assert.equal(readFileSync(join(folder,'status.txt'),'utf8'),'Done: removed\n');
  assert.match(setStatus(root,'2026-11-03_18-42-07','Done: '+'x'.repeat(80)).warning!,/86 characters/);
  assert.throws(()=>setStatus(root,'2026-11-03_18-42-07','Working on it'),/starts with/);
  assert.throws(()=>setStatus(root,'../../etc','Done: x'),/not a take id/);
  assert.throws(()=>setStatus(root,'2026-11-03_18-42-09','Done: x'),/No take/);
  assert.deepEqual(listTakes(root,{pending:true}),[]);
});

test('a take is ready once transcribed, at once when there is no transcriber, and after the wait otherwise',()=>{
  const root=inbox();
  take(root,'2026-11-03_18-00-00',{transcript:'earlier'});
  const tracker=new TakeTracker(root,{wait:60});
  assert.deepEqual(tracker.poll(),[],'takes already there are left alone');
  take(root,'2026-11-03_18-42-07',{transcript:'hello'});
  take(root,'2026-11-03_18-42-08',{context:{transcriber:'none'}});
  const slow=take(root,'2026-11-03_18-42-09');
  const silent=take(root,'2026-11-03_18-42-10',{voice:false});
  assert.deepEqual(tracker.poll().map(t=>t.id),['2026-11-03_18-42-07','2026-11-03_18-42-08']);
  assert.deepEqual(tracker.poll(),[],'each take once');
  age(join(slow,'voice.webm'),61);age(join(silent,'view.png'),61);
  const late=tracker.poll();
  assert.deepEqual(late.map(t=>t.id),['2026-11-03_18-42-09','2026-11-03_18-42-10']);
  assert.match(describe(late[0]),/no transcript: listen to .*voice\.webm/);
  assert.match(describe(late[1]),/no voice: view and context only/);
  const again=new TakeTracker(root,{includeExisting:true,wait:60});
  assert.equal(again.pending,5,'with includeExisting, earlier takes without a status are reported');
});

const bin=(name:string)=>join(import.meta.dirname,'..','src','bin',`${name}.ts`);

test('the watcher prints one line per new take and leaves earlier ones alone',async()=>{
  const root=inbox();
  take(root,'2026-11-03_18-00-00',{transcript:'earlier'});
  const child=spawn(process.execPath,['--experimental-strip-types','--no-warnings',bin('watch'),'--inbox',root,'--every','0.05']);
  let out='';child.stdout.on('data',c=>out+=c);
  try{
    const end=Date.now()+5000;
    while(!out.includes('Watching')){if(Date.now()>end)throw new Error('watcher did not start: '+out);await sleep(20);}
    take(root,'2026-11-03_18-42-07',{transcript:'the ball is too small',context:{summary:'menu'}});
    while(!out.includes('FEEDBACK')){if(Date.now()>end)throw new Error('no line: '+out);await sleep(20);}
    await sleep(150);
    const lines=out.trim().split('\n');
    assert.equal(lines.length,2);
    assert.equal(lines[1].trim(),'FEEDBACK 2026-11-03_18-42-07 [menu]: the ball is too small');
  }finally{child.kill();}
});

test('the MCP server hands out takes, lists them and writes status lines, over stdio',async()=>{
  const root=inbox();
  take(root,'2026-11-03_18-00-00',{transcript:'earlier'});
  const transport=new StdioClientTransport({command:process.execPath,args:['--experimental-strip-types','--no-warnings',bin('mcp'),'--inbox',root],stderr:'pipe'});
  const client=new Client({name:'test',version:'1'});
  await client.connect(transport);
  try{
    const tools=(await client.listTools()).tools.map(t=>t.name).sort();
    assert.deepEqual(tools,['get_feedback','list_feedback','next_feedback','set_status']);
    assert.match(client.getInstructions()??'',/On it:/);
    const call=async(name:string,args:Record<string,unknown>)=>(await client.callTool({name,arguments:args})) as {content:any[];isError?:boolean};
    const waiting=await call('next_feedback',{timeout_seconds:0.2});
    assert.equal(JSON.parse(waiting.content[0].text).waiting,true,'earlier takes are not handed out');
    const next=call('next_feedback',{timeout_seconds:10});
    await sleep(200);
    take(root,'2026-11-03_18-42-07',{transcript:'the ball is too small',context:{summary:'menu'}});
    const got=await next;
    const info=JSON.parse(got.content[0].text);
    assert.equal(info.id,'2026-11-03_18-42-07');assert.equal(info.transcript,'the ball is too small');assert.equal(info.context.summary,'menu');
    assert.deepEqual({type:got.content[1].type,mimeType:got.content[1].mimeType},{type:'image',mimeType:'image/png'});
    assert.deepEqual(Buffer.from(got.content[1].data,'base64'),PNG);
    const set=await call('set_status',{id:info.id,text:'On it: a bigger ball'});
    assert.equal(JSON.parse(set.content[0].text).status,'On it: a bigger ball');
    assert.equal(readFileSync(join(root,info.id,'status.txt'),'utf8'),'On it: a bigger ball\n');
    assert.ok((await call('set_status',{id:info.id,text:'bigger ball'})).isError);
    assert.ok((await call('get_feedback',{id:'nope'})).isError);
    const listed=JSON.parse((await call('list_feedback',{pending_only:true})).content[0].text);
    assert.deepEqual(listed.map((t:{id:string})=>t.id),['2026-11-03_18-00-00']);
    const one=await call('get_feedback',{id:info.id,include_view:false});
    assert.equal(one.content.length,1);assert.deepEqual(JSON.parse(one.content[0].text).statusLines,['On it: a bigger ball']);
  }finally{await client.close();}
});

test('an answer to a question reads back with what it answers, and the watcher says ANSWER',()=>{
  const root=inbox();
  take(root,'2026-11-03_18-42-07',{transcript:'the door is wrong'});
  setStatus(root,'2026-11-03_18-42-07','Question: lock the door or remove it?');
  take(root,'2026-11-03_18-43-00',{transcript:'remove it',context:{replyTo:'2026-11-03_18-42-07',question:'Question: lock the door or remove it?'}});
  const answer=readTake(root,'2026-11-03_18-43-00')!;
  assert.equal(answer.replyTo,'2026-11-03_18-42-07');assert.equal(answer.question,'Question: lock the door or remove it?');
  assert.equal(describe(answer),'ANSWER 2026-11-03_18-43-00 to 2026-11-03_18-42-07 [Question: lock the door or remove it?]: remove it');
  take(root,'2026-11-03_18-44-00',{transcript:'x',context:{replyTo:'../../etc'}});
  assert.equal(readTake(root,'2026-11-03_18-44-00')!.replyTo,null,'a malformed replyTo is ignored');
});

test('over MCP, an answer comes with the asking take and what to do next',async()=>{
  const root=inbox();
  take(root,'2026-11-03_18-42-07',{transcript:'the door is wrong'});
  setStatus(root,'2026-11-03_18-42-07','Question: lock the door or remove it?');
  const transport=new StdioClientTransport({command:process.execPath,args:['--experimental-strip-types','--no-warnings',bin('mcp'),'--inbox',root],stderr:'pipe'});
  const client=new Client({name:'test',version:'1'});
  await client.connect(transport);
  try{
    assert.match(client.getInstructions()??'',/replyTo/);
    const next=client.callTool({name:'next_feedback',arguments:{timeout_seconds:10,include_view:false}});
    await sleep(200);
    take(root,'2026-11-03_18-43-00',{transcript:'remove it',context:{replyTo:'2026-11-03_18-42-07',question:'Question: lock the door or remove it?'}});
    const got=await next as {content:{text:string}[]};
    const info=JSON.parse(got.content[0].text);
    assert.equal(info.replyTo,'2026-11-03_18-42-07');
    assert.equal(info.answers.transcript,'the door is wrong');
    assert.deepEqual(info.answers.statusLines,['Question: lock the door or remove it?']);
    assert.match(info.next,/set_status on 2026-11-03_18-42-07/);
  }finally{await client.close();}
});

test('a take with screenshots lists every view in order, with when and why, for the watcher and over MCP',async()=>{
  const root=inbox();
  take(root,'2026-11-03_18-00-00',{transcript:'earlier'});
  const transport=new StdioClientTransport({command:process.execPath,args:['--experimental-strip-types','--no-warnings',bin('mcp'),'--inbox',root],stderr:'pipe'});
  const client=new Client({name:'test',version:'1'});
  await client.connect(transport);
  try{
    const next=client.callTool({name:'next_feedback',arguments:{timeout_seconds:10}});
    await sleep(200);
    const folder=join(root,'2026-11-03_18-42-07');mkdirSync(folder);
    for(const file of ['view.png','view-2.png','view-10.png','view-3.png'])writeFileSync(join(folder,file),PNG);
    writeFileSync(join(folder,'views.json'),JSON.stringify([{file:'view.png',seconds:0,trigger:'start'},{file:'view-2.png',seconds:4.2,trigger:'voice'},{file:'view-3.png',seconds:6,trigger:'button'}]));
    writeFileSync(join(folder,'context.json'),'{"transcriber":"whisper"}');writeFileSync(join(folder,'voice.webm'),'x');
    writeFileSync(join(folder,'transcript.txt'),'here, take a screenshot, and this\n');
    const t=readTake(root,'2026-11-03_18-42-07')!;
    assert.deepEqual(t.views.map(v=>[v.file,v.seconds,v.trigger]),[['view.png',0,'start'],['view-2.png',4.2,'voice'],['view-3.png',6,'button'],['view-10.png',null,null]]);
    assert.equal(describe(t),'FEEDBACK 2026-11-03_18-42-07 (+3 screenshots): here, take a screenshot, and this');
    const got=await next as {content:{type:string;text?:string}[]};
    assert.deepEqual(got.content.map(c=>c.type),['text','text','image','text','image','text','image','text','image']);
    assert.equal(got.content[3].text,'view-2.png: asked for by voice at 4.2 s');
    assert.equal(JSON.parse(got.content[0].text!).views.length,4);
  }finally{await client.close();}
});
