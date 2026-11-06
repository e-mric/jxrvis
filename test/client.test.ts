import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {setTimeout as sleep} from 'node:timers/promises';
import {feedbackInbox} from '../src/server/inbox.ts';
import {createFeedbackClient,type ClientOptions,type RecorderLike} from '../src/client/core.ts';
import {wrap} from '../src/client/label-lines.ts';

const IMAGE=`data:image/png;base64,${Buffer.from('89504e470d0a1a0a','hex').toString('base64')}`;

class FakeRecorder implements RecorderLike{
  mimeType='audio/webm;codecs=opus';
  ondataavailable:((event:{data:Blob})=>void)|null=null;
  onstop:(()=>void)|null=null;
  started=false;
  start(){this.started=true;}
  stop(){this.ondataavailable?.({data:new Blob(['opus audio'],{type:this.mimeType})});queueMicrotask(()=>this.onstop?.());}
}

async function loop(options:Partial<ClientOptions>={},transcribe:any=async()=>'the door does not open'){
  const root=join(mkdtempSync(join(tmpdir(),'jxrvis-client-')),'inbox');
  const handle=feedbackInbox({root,transcribe});
  const server=createServer((req,res)=>void handle(req,res,()=>{res.writeHead(404);res.end();}));
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const shown:string[]=[],sounds:string[]=[],changes:boolean[]=[],recorders:FakeRecorder[]=[];
  let snaps=0;
  const client=createFeedbackClient({
    base:`${origin}/api/feedback`,
    snapshot:()=>{snaps++;return {image:IMAGE,details:{xr:false,head:{position:[0,1.6,0],looking:[0,0,-1]}}};},
    context:()=>({summary:'level 3',level:3}),
    show:text=>shown.push(text),
    sound:event=>sounds.push(event),
    changed:recording=>changes.push(recording),
    agentName:'Claude',
    microphone:async()=>({getTracks:()=>[]}) as unknown as MediaStream,
    recorder:()=>{const r=new FakeRecorder();recorders.push(r);return r;},
    captureErrors:false,
    timing:{lookUp:.05,shortest:.02,longest:5,followEvery:.02,followFor:5},
    ...options,
  });
  const takes=()=>{try{return readdirSync(root).filter(n=>n!=='.gitignore');}catch{return [];}};
  return {root,client,shown,sounds,changes,recorders,takes,snaps:()=>snaps,close:()=>{client.dispose();server.close();}};
}
const until=async(check:()=>boolean,what:string,ms=3000)=>{const end=Date.now()+ms;while(!check()){if(Date.now()>end)throw new Error(`timed out waiting for ${what}`);await sleep(5);}};

test('hold to talk: the view is taken on press, the voice on release, then the agent\'s status is followed to Done',async()=>{
  const t=await loop();
  try{
    t.client.press();
    await until(()=>t.recorders[0]?.started,'recording');
    assert.equal(t.snaps(),1,'snapshot as the button goes down');
    assert.ok(t.client.recording);
    assert.equal(t.shown.at(-1),'● Recording… let go to save');
    await sleep(40);t.client.release();
    await until(()=>t.shown.some(s=>s.startsWith('Saved: ')),'saved');
    assert.equal(t.shown.at(-1),'Saved: “the door does not open”');
    const [id]=t.takes();
    const folder=join(t.root,id);
    assert.deepEqual(readdirSync(folder).sort(),['context.json','transcript.txt','view.png','voice.webm']);
    const context=JSON.parse(readFileSync(join(folder,'context.json'),'utf8'));
    assert.equal(context.summary,'level 3');assert.deepEqual(context.app,{level:3});
    assert.equal(context.xr,false);assert.equal(typeof context.seconds,'number','seconds, to one decimal');assert.deepEqual(context.recentErrors,[]);
    assert.equal(readFileSync(join(folder,'voice.webm'),'utf8'),'opus audio');
    writeFileSync(join(folder,'status.txt'),'On it: the door handle\n');
    await until(()=>t.shown.at(-1)==='Claude: On it: the door handle','first status');
    writeFileSync(join(folder,'status.txt'),'On it: the door handle\nDone: door opens, reload to see\n');
    await until(()=>t.shown.at(-1)==='Claude: Done: door opens, reload to see','done');
    assert.deepEqual(t.sounds,['start','saved','status','status']);
    assert.deepEqual(t.changes.filter((v,i,a)=>v!==a[i-1]),[true,false]);
    assert.equal(await t.client.follow(id),'Done: door opens, reload to see','follow stops at Done');
  }finally{t.close();}
});

test('toggle: the view waits for the player to look back from the menu, and a second toggle stops',async()=>{
  const t=await loop();
  try{
    t.client.toggle();
    await until(()=>t.recorders[0]?.started,'recording');
    assert.equal(t.snaps(),0);assert.equal(t.shown.at(-1),'Look at it… snapshot in a moment');
    await until(()=>t.snaps()===1,'delayed snapshot');
    assert.equal(t.shown.at(-1),'● Recording… press again to stop');
    t.client.toggle();
    await until(()=>t.takes().length===1&&t.shown.some(s=>s.startsWith('Saved')),'saved');
    assert.equal(t.snaps(),1);
  }finally{t.close();}
});

test('a toggle stopped before its snapshot still saves a view, taken at the stop',async()=>{
  const t=await loop({timing:{lookUp:10,shortest:0,longest:5,followEvery:.02,followFor:.1}});
  try{
    t.client.toggle();await until(()=>t.recorders[0]?.started,'recording');
    t.client.holdDown();
    await until(()=>t.shown.some(s=>s.startsWith('Saved')),'saved');
    assert.equal(t.snaps(),1);
  }finally{t.close();}
});

test('a take shorter than the shortest is dropped, and nothing reaches the inbox',async()=>{
  const t=await loop({timing:{shortest:5}});
  try{
    t.client.press();await until(()=>t.recorders[0]?.started,'recording');
    t.client.release();
    await until(()=>t.shown.at(-1)==='Too short, not saved','dropped');
    await sleep(30);assert.deepEqual(t.takes(),[]);
  }finally{t.close();}
});

test('a release that comes while the microphone is still opening stops the take once it starts',async()=>{
  let open!:()=>void;
  const t=await loop({microphone:()=>new Promise(resolve=>{open=()=>resolve({getTracks:()=>[]} as unknown as MediaStream);}),timing:{shortest:0,followEvery:.02,followFor:.1}});
  try{
    t.client.press();await until(()=>!!open,'microphone asked');
    t.client.release();open();
    await until(()=>t.shown.some(s=>s.startsWith('Saved')),'saved');
    assert.equal(t.takes().length,1);
  }finally{t.close();}
});

test('a recording stops by itself after the longest time',async()=>{
  const t=await loop({timing:{longest:.08,shortest:0,followEvery:.02,followFor:.1}});
  try{
    t.client.press();
    await until(()=>t.shown.some(s=>s.startsWith('Saved')),'auto-stopped and saved');
    assert.equal(t.client.recording,false);
  }finally{t.close();}
});

test('voice only: without a transcriber the label says so',async()=>{
  const t=await loop({},'none');
  try{
    t.client.press();await until(()=>t.recorders[0]?.started,'recording');
    await sleep(30);t.client.release();
    await until(()=>t.shown.at(-1)==='Saved (voice only)','saved');
  }finally{t.close();}
});

test('without the dev server, or the microphone, the player is told and nothing records',async()=>{
  const shown:string[]=[];
  const offline=createFeedbackClient({base:'http://127.0.0.1:9/api/feedback',snapshot:()=>IMAGE,show:text=>shown.push(text),captureErrors:false});
  offline.press();
  await until(()=>shown.length>0,'message');
  assert.equal(shown[0],'Feedback needs the dev server on the PC');assert.equal(offline.recording,false);
  const t=await loop({microphone:async()=>{throw new Error('NotAllowedError');}});
  try{
    t.client.press();
    await until(()=>t.shown.length>0,'message');
    assert.equal(t.shown[0],'The microphone is not available');assert.equal(t.recorders.length,0);
  }finally{t.close();}
});

test('a failed upload is reported, not thrown',async()=>{
  const t=await loop({snapshot:()=>'data:text/plain;base64,eA==',timing:{shortest:0}});
  const original=console.error;console.error=()=>{};
  try{
    t.client.press();await until(()=>t.recorders[0]?.started,'recording');
    t.client.release();
    await until(()=>t.shown.at(-1)==='Feedback could not be saved','error shown');
    assert.equal(t.sounds.at(-1),'error');
  }finally{console.error=original;t.close();}
});

test('submit uploads a take directly, for scripts and synthetic tests',async()=>{
  const t=await loop();
  try{
    const {id,transcript}=await t.client.submit(IMAGE,new Blob(['wav'],{type:'audio/wav'}),1.25);
    assert.equal(transcript,'the door does not open');
    assert.deepEqual(readdirSync(join(t.root,id)).sort(),['context.json','transcript.txt','view.png','voice.wav']);
    assert.equal(JSON.parse(readFileSync(join(t.root,id,'context.json'),'utf8')).seconds,1.3);
  }finally{t.close();}
});

test('the label keeps a short line whole and breaks a long one into two at a space',()=>{
  assert.deepEqual(wrap('Saving feedback…'),['Saving feedback…']);
  assert.deepEqual(wrap('Claude: Done: the ball is bigger, reload to see it'),['Claude: Done: the ball is bigger, reload','to see it']);
  const long=wrap('Claude: On it: the striker kicks with the wrong foot in the second replay of the goal and the keeper dives late');
  assert.equal(long.length,2);assert.ok(long[1].endsWith('…'));assert.ok(long.every(line=>line.length<=42));
  assert.deepEqual(wrap('a\n  b'),['a b']);
});

test('Question, Done and Skipped are read aloud; On it only plays the status sound',async()=>{
  const said:string[]=[];
  const t=await loop({voice:text=>{said.push(text);}});
  try{
    t.client.press();await until(()=>t.recorders[0]?.started,'recording');
    await sleep(30);t.client.release();
    await until(()=>t.takes().length===1&&t.shown.some(s=>s.startsWith('Saved')),'saved');
    const folder=join(t.root,t.takes()[0]);
    writeFileSync(join(folder,'status.txt'),'On it: the door\n');
    await until(()=>t.shown.at(-1)==='Claude: On it: the door','on it shown');
    assert.deepEqual(said,[]);
    writeFileSync(join(folder,'status.txt'),'On it: the door\nDone: door opens, reload to see\n');
    await until(()=>said.length===1,'done spoken');
    assert.deepEqual(said,['Done. door opens, reload to see']);
  }finally{t.close();}
});

test('the player answers a question by voice: the next take is a reply, and the asking take is still followed',async()=>{
  const said:string[]=[];
  const t=await loop({voice:text=>{said.push(text);}});
  const record=async(n:number)=>{
    t.client.press();await until(()=>t.recorders.length===n&&t.recorders[n-1].started,'recording');
    await sleep(30);t.client.release();
  };
  try{
    await record(1);
    await until(()=>t.takes().length===1&&t.shown.some(s=>s.startsWith('Saved')),'first take saved');
    const asking=t.takes()[0];
    writeFileSync(join(t.root,asking,'status.txt'),'Question: lock the door or remove it?\n');
    await until(()=>said.length===1,'question spoken');
    assert.equal(said[0],'Question. lock the door or remove it? Hold the talk button to answer.');
    assert.deepEqual(t.client.question,{id:asking,text:'Question: lock the door or remove it?'});
    await record(2);
    assert.equal(t.shown.find(s=>s.startsWith('● '))?.startsWith('● Recording'),true);
    await until(()=>t.shown.at(-1)?.startsWith('Answer sent')??false,'answer sent');
    assert.equal(t.shown.at(-1),'Answer sent: “the door does not open”');
    assert.ok(t.shown.includes('● Answering… let go to send'));
    const reply=t.takes().find(id=>id!==asking)!;
    const context=JSON.parse(readFileSync(join(t.root,reply,'context.json'),'utf8'));
    assert.equal(context.replyTo,asking);assert.equal(context.question,'Question: lock the door or remove it?');
    assert.equal(t.client.question,undefined,'one answer per question');
    writeFileSync(join(t.root,reply,'status.txt'),'Done: answer to '+asking+'\n');
    writeFileSync(join(t.root,asking,'status.txt'),'Question: lock the door or remove it?\nDone: door removed, reload to see\n');
    await until(()=>said.length===2,'done on the asking take spoken');
    assert.equal(said[1],'Done. door removed, reload to see');
    assert.ok(!t.shown.some(s=>s.includes('answer to')),'the reply take is not followed');
    await record(3);
    await until(()=>t.takes().length===3&&t.shown.at(-1)?.startsWith('Saved')===true,'third take saved');
    const third=t.takes().find(id=>id!==asking&&id!==reply)!;
    assert.equal(JSON.parse(readFileSync(join(t.root,third,'context.json'),'utf8')).replyTo,undefined,'after Done, takes are new feedback again');
  }finally{t.close();}
});

test('speech can be turned off, or replaced with your own speaker',async()=>{
  const said:string[]=[];
  const t=await loop({voice:'off'});
  try{
    t.client.press();await until(()=>t.recorders[0]?.started,'recording');
    await sleep(30);t.client.release();
    await until(()=>t.takes().length===1&&t.shown.some(s=>s.startsWith('Saved')),'saved');
    writeFileSync(join(t.root,t.takes()[0],'status.txt'),'Done: fixed\n');
    await until(()=>t.shown.at(-1)==='Claude: Done: fixed','shown');
    assert.equal(t.client.voice,'off');
    t.client.voice=text=>{said.push(text);};
    assert.deepEqual(said,[]);
  }finally{t.close();}
  const {spoken}=await import('../src/client/core.ts');
  assert.equal(spoken('Skipped:   not   a bug'),'Skipped. not a bug');
  assert.equal(spoken('Fine'),'Fine');
});

class StreamingRecorder extends FakeRecorder{
  private timer?:ReturnType<typeof setInterval>;
  start(){super.start();this.timer=setInterval(()=>this.ondataavailable?.({data:new Blob(['chunk'],{type:this.mimeType})}),10);}
  stop(){clearInterval(this.timer);super.stop();}
}

test('the screenshot button takes more views during a take; they are saved as view-2, view-3 with when and why',async()=>{
  const t=await loop({transcribe:undefined} as any);
  try{
    t.client.press();await until(()=>t.recorders[0]?.started,'recording');
    assert.equal(t.client.shot(),true);
    await sleep(20);
    assert.equal(t.client.shot(),true);
    assert.equal(t.shown.at(-1),'● Recording… screenshot 3 taken');
    await sleep(20);t.client.release();
    await until(()=>t.shown.some(s=>s.startsWith('Saved')),'saved');
    const folder=join(t.root,t.takes()[0]);
    assert.deepEqual(readdirSync(folder).sort(),['context.json','transcript.txt','view-2.png','view-3.png','view.png','views.json','voice.webm']);
    const views=JSON.parse(readFileSync(join(folder,'views.json'),'utf8'));
    assert.deepEqual(views.map((v:{file:string;trigger:string})=>[v.file,v.trigger]),[['view.png','start'],['view-2.png','button'],['view-3.png','button']]);
    assert.deepEqual(views[1].head,{position:[0,1.6,0],looking:[0,0,-1]});
    assert.ok(t.sounds.filter(s=>s==='shot').length===2);
    assert.equal(t.client.shot(),false,'no screenshot outside a take');
  }finally{t.close();}
});

test('saying "take a screenshot" while recording takes one view per phrase, listening only to new audio',async()=>{
  const froms:number[]=[];let calls=0;
  const transcriber={name:'fake',transcribe:async()=>'the ball, take a screenshot, is too big',listen:async(_:Buffer,{from}:{from:number})=>{froms.push(from);calls++;return calls===2?'the ball, take a screenshot':'the ball';}};
  const root=join(mkdtempSync(join(tmpdir(),'jxrvis-client-')),'inbox');
  const handle=feedbackInbox({root,transcribe:transcriber});
  const server=createServer((req,res)=>void handle(req,res,()=>{res.writeHead(404);res.end();}));
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const shown:string[]=[];
  const client=createFeedbackClient({
    base:`http://127.0.0.1:${(server.address() as {port:number}).port}/api/feedback`,
    snapshot:()=>IMAGE,show:text=>shown.push(text),captureErrors:false,voice:'off',
    microphone:async()=>({getTracks:()=>[]}) as unknown as MediaStream,
    recorder:()=>new StreamingRecorder(),
    timing:{shortest:0,listenEvery:.05,followEvery:.05,followFor:.2},
  });
  try{
    client.press();
    await until(()=>shown.includes('● Recording… screenshot 2 taken'),'voice shot');
    await until(()=>calls>=5,'more listening');
    client.release();
    await until(()=>shown.some(s=>s.startsWith('Saved')),'saved');
    const [id]=readdirSync(root).filter(n=>n!=='.gitignore');
    const views=JSON.parse(readFileSync(join(root,id,'views.json'),'utf8'));
    assert.deepEqual(views.map((v:{trigger:string})=>v.trigger),['start','voice'],'one phrase, one view');
    assert.equal(froms[0],0);
    assert.ok(froms[2]>0&&froms[2]>=froms[1],'after a hit it listens only to what comes next');
  }finally{client.dispose();server.close();}
});

test('the shot phrase understands the usual ways to ask for a screenshot',async()=>{
  const {SHOT_PHRASE}=await import('../src/client/core.ts');
  for(const said of ['Take a screenshot.','take another screenshot','grab a snapshot','Take one more picture','take a screen shot','get a photo'])assert.match(said,SHOT_PHRASE,said);
  for(const said of ['the screenshot shows','I took a nap','take a seat'])assert.doesNotMatch(said,SHOT_PHRASE,said);
});
