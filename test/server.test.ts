import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import http2 from 'node:http2';
import {existsSync,mkdtempSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {feedbackInbox,type InboxOptions} from '../src/server/inbox.ts';
import {createFeedbackServer} from '../src/server/standalone.ts';
import {httpTranscriber} from '../src/server/transcribers.ts';
import {jxrvis} from '../src/server/vite.ts';

const PNG=Buffer.from('89504e470d0a1a0a0000000d49484452','hex');
const IMAGE=`data:image/png;base64,${PNG.toString('base64')}`;
const temp=()=>mkdtempSync(join(tmpdir(),'jxrvis-'));

async function inbox(options:Partial<InboxOptions>={}){
  const root=join(temp(),'inbox');
  const handle=feedbackInbox({root,now:()=>new Date(2026,10,3,18,42,7),...options});
  const server=createServer((req,res)=>void handle(req,res,()=>{res.writeHead(418);res.end();}));
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  return {root,base,close:()=>server.close()};
}
const view=(base:string,extra:RequestInit={},path='/api/feedback')=>fetch(`${base}${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({image:IMAGE,context:{summary:'level 3',xr:true}}),...extra});
const voice=(base:string,id:string,type='audio/webm;codecs=opus',body='opus audio')=>fetch(`${base}/api/feedback/${id}/voice`,{method:'POST',headers:{'Content-Type':type},body:Buffer.from(body)});

test('a take keeps what the player saw, what they said and its transcript in one folder',async()=>{
  const heard:{audio:string;type:string;id:string}[]=[];
  const {root,base,close}=await inbox({transcribe:async(audio,info)=>{heard.push({audio:audio.toString(),...info});return ' the door does not open ';}});
  try{
    const saved=await view(base);assert.equal(saved.status,200);
    const {id}=await saved.json() as {id:string};
    assert.equal(id,'2026-11-03_18-42-07');
    assert.deepEqual(await (await voice(base,id)).json(),{id,transcript:'the door does not open'});
    const folder=join(root,id);
    assert.deepEqual(readdirSync(folder).sort(),['context.json','transcript.txt','view.png','voice.webm']);
    assert.deepEqual(readFileSync(join(folder,'view.png')),PNG);
    const context=JSON.parse(readFileSync(join(folder,'context.json'),'utf8'));
    assert.equal(context.summary,'level 3');assert.equal(context.savedAt,new Date(2026,10,3,18,42,7).toISOString());
    assert.equal(readFileSync(join(folder,'transcript.txt'),'utf8'),'the door does not open\n');
    assert.deepEqual(heard,[{audio:'opus audio',type:'audio/webm',id}]);
    assert.equal((await view(base).then(r=>r.json()) as {id:string}).id,'2026-11-03_18-42-07-2','a second take in the same second gets its own folder');
    assert.equal(readFileSync(join(root,'.gitignore'),'utf8').trim().split('\n').at(-1),'*','the inbox ignores itself in git');
  }finally{close();}
});

test('with no transcriber a take keeps its voice and gets no transcript',async()=>{
  const {root,base,close}=await inbox({transcribe:'none'});
  try{
    assert.deepEqual(await fetch(`${base}/api/feedback/health`).then(r=>r.json()),{ok:true,transcriber:'none',speech:'none'});
    const {id}=await view(base).then(r=>r.json()) as {id:string};
    assert.deepEqual(await (await voice(base,id,'audio/ogg')).json(),{id,transcript:null});
    assert.deepEqual(readdirSync(join(root,id)).sort(),['context.json','view.png','voice.ogg']);
  }finally{close();}
});

test('the voice is kept when the transcriber is down, so it can be transcribed later',async()=>{
  const {root,base,close}=await inbox({transcribe:async()=>{throw new Error('speech server offline');}});
  try{
    const {id}=await view(base).then(r=>r.json()) as {id:string};
    const reply=await (await voice(base,id,'audio/mp4','aac')).json() as {transcript:string|null;error:string};
    assert.equal(reply.transcript,null);assert.match(reply.error,/offline/);
    assert.ok(existsSync(join(root,id,'voice.m4a')));assert.ok(!existsSync(join(root,id,'transcript.txt')));
  }finally{close();}
});

test('an HTTP transcriber gets the audio with its type and returns its text',async()=>{
  const got:{type?:string;body:string}[]=[];
  const fake=createServer(async(req,res)=>{
    const chunks:Buffer[]=[];for await(const c of req)chunks.push(c as Buffer);
    got.push({type:req.headers['content-type'],body:Buffer.concat(chunks).toString()});
    if(req.url==='/broken'){res.writeHead(500);res.end('model not loaded');return;}
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({text:'hola'}));
  });
  fake.listen(0,'127.0.0.1');await once(fake,'listening');
  const url=`http://127.0.0.1:${(fake.address() as {port:number}).port}`;
  try{
    assert.equal(await httpTranscriber(`${url}/transcribe`).transcribe(Buffer.from('wav'),{type:'audio/wav',id:'x'}),'hola');
    assert.deepEqual(got[0],{type:'audio/wav',body:'wav'});
    await assert.rejects(httpTranscriber(`${url}/broken`).transcribe(Buffer.from('x'),{type:'audio/wav',id:'x'}),/500: model not loaded/);
    const {base,close}=await inbox({transcribe:`${url}/transcribe`});
    try{
      const {id}=await view(base).then(r=>r.json()) as {id:string};
      assert.equal((await (await voice(base,id)).json() as {transcript:string}).transcript,'hola','a URL option means an HTTP transcriber');
    }finally{close();}
  }finally{fake.close();}
});

test('over HTTP/2, as HTTPS dev servers run, the page\'s own origin is let in by :authority',async()=>{
  const handle=feedbackInbox({root:temp()});
  const server=http2.createServer((req,res)=>void handle(req,res,()=>{res.writeHead(404);res.end();}));
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const authority=`127.0.0.1:${(server.address() as {port:number}).port}`,client=http2.connect(`http://${authority}`);
  const post=(origin:string)=>new Promise<number>((resolve,reject)=>{
    const req=client.request({':method':'POST',':path':'/api/feedback','content-type':'application/json',origin});
    req.on('response',headers=>{resolve(headers[':status'] as number);req.resume();});req.on('error',reject);
    req.end(JSON.stringify({image:IMAGE,context:{}}));
  });
  try{
    assert.equal(await post(`https://${authority}`),200);
    assert.equal(await post('https://elsewhere.example'),403);
  }finally{client.close();server.close();}
});

test('the inbox refuses other sites, unknown or malformed ids and anything that is not a screenshot',async()=>{
  const {root,base,close}=await inbox();
  try{
    assert.equal((await view(base,{headers:{'Content-Type':'application/json',Origin:'https://elsewhere.example'}})).status,403);
    assert.equal((await view(base,{headers:{'Content-Type':'application/json',Origin:'not a url'}})).status,403);
    const post=(body:string)=>fetch(`${base}/api/feedback`,{method:'POST',headers:{'Content-Type':'application/json'},body});
    assert.equal((await post(JSON.stringify({image:'data:text/html;base64,PGI+',context:{}}))).status,400);
    assert.equal((await post('{not json')).status,400);
    assert.equal((await post(JSON.stringify({image:IMAGE,context:[1]}))).status,400);
    for(const id of ['..%2F..%2Fescape','2026-11-03_18-42-07','%E0%A4%A'])
      assert.equal((await voice(base,id)).status,404);
    assert.ok(!existsSync(root),'nothing was written');
    assert.equal((await fetch(`${base}/api/feedback/nope`)).status,404);
    assert.equal((await fetch(`${base}/api/feedbackish`)).status,418,'paths outside the base go to the next handler');
    const {id}=await view(base).then(r=>r.json()) as {id:string};
    assert.equal((await voice(base,id,'text/plain')).status,400);
  }finally{close();}
});

test('bodies over the limit are refused with 413',async()=>{
  const {base,close}=await inbox({maxViewBytes:50,maxVoiceBytes:5});
  try{
    assert.equal((await view(base)).status,413);
    const small=await inbox({maxVoiceBytes:5});
    try{const {id}=await view(small.base).then(r=>r.json()) as {id:string};assert.equal((await voice(small.base,id)).status,413);}finally{small.close();}
  }finally{close();}
});

test('the headset reads back the agent\'s current status: the last line of status.txt',async()=>{
  const {root,base,close}=await inbox();
  try{
    const {id}=await view(base).then(r=>r.json()) as {id:string};
    const status=()=>fetch(`${base}/api/feedback/${id}/status`).then(r=>r.json()) as Promise<{status:string|null}>;
    assert.deepEqual(await status(),{status:null});
    writeFileSync(join(root,id,'status.txt'),'On it: a bigger ball\n');
    assert.deepEqual(await status(),{status:'On it: a bigger ball'});
    writeFileSync(join(root,id,'status.txt'),'On it: a bigger ball\r\nDone: ball is bigger, reload to see\n\n');
    assert.deepEqual(await status(),{status:'Done: ball is bigger, reload to see'});
    for(const bad of ['2026-11-03_18-42-08','..%2Fescape'])assert.equal((await fetch(`${base}/api/feedback/${bad}/status`)).status,404);
  }finally{close();}
});

test('a custom base path moves every route',async()=>{
  const {base,close}=await inbox({base:'/dev/notes/'});
  try{
    assert.equal((await fetch(`${base}/dev/notes/health`)).status,200);
    assert.equal((await view(base,{},'/dev/notes')).status,200);
    assert.equal((await fetch(`${base}/api/feedback/health`)).status,418);
  }finally{close();}
});

test('the Vite plugin serves the inbox from the dev and preview servers, under Vite\'s root',async()=>{
  const plugin=jxrvis({inbox:'notes/inbox',transcribe:'none'});
  const root=temp(),logged:string[]=[];
  for(const hook of [plugin.configureServer,plugin.configurePreviewServer]){
    let installed:((req:any,res:any,next:()=>void)=>void)|undefined;
    hook({config:{root,logger:{info:line=>logged.push(line)}},middlewares:{use:h=>{installed=h;}}});
    const server=createServer((req,res)=>installed!(req,res,()=>{res.writeHead(418);res.end();}));
    server.listen(0,'127.0.0.1');await once(server,'listening');
    const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
    try{
      const {id}=await view(base).then(r=>r.json()) as {id:string};
      assert.ok(existsSync(join(root,'notes/inbox',id,'view.png')));
      await voice(base,id);
      assert.equal((await fetch(`${base}/index.html`)).status,418);
    }finally{server.close();}
  }
  assert.match(logged[0],/\[jXRvis\] take .*: voice saved \(no transcriber\)/);
});

function certificate(){
  const dir=temp();
  try{
    execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost','-keyout',join(dir,'key.pem'),'-out',join(dir,'cert.pem')],{stdio:'ignore'});
    return {cert:join(dir,'cert.pem'),key:join(dir,'key.pem')};
  }catch{return null;}
}

test('the standalone server serves the inbox and a static page over HTTPS with HTTP/2',async t=>{
  const pem=certificate();
  if(!pem)return t.skip('openssl is not installed');
  const site=temp();writeFileSync(join(site,'index.html'),'<h1>xr</h1>');
  const root=join(temp(),'inbox');
  const server=createFeedbackServer({root,static:site,...pem});
  const {port}=await server.listen(0,'127.0.0.1');
  const client=http2.connect(`https://127.0.0.1:${port}`,{rejectUnauthorized:false});
  const request=(headers:http2.OutgoingHttpHeaders,body?:string)=>new Promise<{status:number;text:string}>((resolve,reject)=>{
    const req=client.request(headers);let text='';
    req.setEncoding('utf8');req.on('data',c=>text+=c);
    let status=0;req.on('response',h=>status=h[':status'] as number);
    req.on('end',()=>resolve({status,text}));req.on('error',reject);req.end(body);
  });
  try{
    assert.ok(server.secure);
    assert.deepEqual(await request({':path':'/'}),{status:200,text:'<h1>xr</h1>'});
    assert.equal((await request({':path':'/../../etc/hosts'})).status,404);
    const saved=await request({':method':'POST',':path':'/api/feedback','content-type':'application/json',origin:`https://127.0.0.1:${port}`},JSON.stringify({image:IMAGE,context:{}}));
    assert.equal(saved.status,200);
    assert.ok(existsSync(join(root,JSON.parse(saved.text).id,'view.png')));
  }finally{client.close();await server.close();}
});

test('the standalone server speaks plain HTTP without a certificate, for localhost and adb reverse',async()=>{
  const server=createFeedbackServer({root:temp()});
  const {url}=await server.listen();
  try{
    assert.equal(url.startsWith('http://'),true);
    assert.equal((await fetch(`${url}/api/feedback/health`)).status,200);
    assert.equal((await fetch(`${url}/`)).status,404,'no static folder, no page');
  }finally{await server.close();}
  assert.throws(()=>createFeedbackServer({root:temp(),cert:'x.pem'}),/both/);
});

test('the optional speech route speaks a status line as audio, and is absent without an engine',async()=>{
  const said:string[]=[];
  const {base,close}=await inbox({speech:async text=>{said.push(text);return {audio:new Uint8Array([82,73,70,70]),type:'audio/wav'};}});
  const speak=(body:unknown,b=base)=>fetch(`${b}/api/feedback/speech`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  try{
    assert.equal((await fetch(`${base}/api/feedback/health`).then(r=>r.json()) as {speech:string}).speech,'speech');
    const reply=await speak({text:'  Done. Ball moved down. '});
    assert.equal(reply.status,200);assert.equal(reply.headers.get('content-type'),'audio/wav');
    assert.deepEqual(new Uint8Array(await reply.arrayBuffer()),new Uint8Array([82,73,70,70]));
    assert.deepEqual(said,['Done. Ball moved down.']);
    assert.equal((await speak({text:''})).status,400);
    assert.equal((await speak({text:'x'.repeat(1001)})).status,400);
    assert.equal((await speak({text:'hi'},base)).status,200);
  }finally{close();}
  const failing=await inbox({speech:async()=>{throw new Error('voice model missing');}});
  try{assert.equal((await speak({text:'hi'},failing.base)).status,502);}finally{failing.close();}
  const none=await inbox();
  try{assert.equal((await speak({text:'hi'},none.base)).status,404);}finally{none.close();}
});

test('an HTTP speech server gets the text as JSON and must answer audio',async()=>{
  const {httpSpeech}=await import('../src/server/speech.ts');
  let got='';
  const fake=createServer(async(req,res)=>{
    const chunks:Buffer[]=[];for await(const c of req)chunks.push(c as Buffer);got=Buffer.concat(chunks).toString();
    if(req.url==='/html'){res.writeHead(200,{'Content-Type':'text/html'});res.end('<p>');return;}
    res.writeHead(200,{'Content-Type':'audio/mpeg'});res.end(Buffer.from('mp3'));
  });
  fake.listen(0,'127.0.0.1');await once(fake,'listening');
  const url=`http://127.0.0.1:${(fake.address() as {port:number}).port}`;
  try{
    const {audio,type}=await httpSpeech(`${url}/tts`).speak('hola');
    assert.equal(type,'audio/mpeg');assert.equal(Buffer.from(audio).toString(),'mp3');assert.deepEqual(JSON.parse(got),{text:'hola'});
    await assert.rejects(httpSpeech(`${url}/html`).speak('x'),/not audio/);
  }finally{fake.close();}
});
