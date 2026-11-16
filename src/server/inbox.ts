import {randomInt,timingSafeEqual} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import type {IncomingMessage} from 'node:http';
import type {Http2ServerRequest} from 'node:http2';
import {isIP} from 'node:net';
import {join} from 'node:path';
import {DEFAULT_BASE,FILES,VIEW_EXTENSIONS,VOICE_EXTENSIONS,VOICE_TYPES,currentStatus,isId,stamp} from '../spec.ts';
import {resolveSpeech,type SpeechOption} from './speech.ts';
import {resolveTranscriber,type TranscriberOption} from './transcribers.ts';

const IMAGE=/^data:image\/(png|jpeg);base64,/;
/** The header that carries the pairing token (SPEC.md "Pairing"). */
export const TOKEN_HEADER='x-jxrvis-token';
const TOKEN_FILE='.token';
const TOKEN_LETTERS='abcdefghjkmnpqrstuvwxyz23456789';

export interface InboxOptions{
  /** The inbox folder (SPEC.md). Created on the first take, with a .gitignore so takes are never committed. */
  root:string;
  /** 'none' (default), a transcription server URL, a function or a Transcriber. */
  transcribe?:TranscriberOption;
  /** 'none' (default: headsets use their own voice), a text-to-speech server URL, a function or a Speech. */
  speech?:SpeechOption;
  /** URL path the routes live under. */
  base?:string;
  maxViewBytes?:number;
  maxVoiceBytes?:number;
  /**
   * Requests from another machine (a headset on the network) must carry this token. Default: a random
   * token kept in `<root>/.token`, which jXRvis prints with the pairing address. false: no token, so anyone
   * who can reach the server can send takes to your agent.
   */
  token?:string|false;
  /** Client addresses that need no token, in addition to this PC (loopback), e.g. your headset's IP. */
  trust?:string[];
  /**
   * Host names the requests may name, against DNS rebinding. IP addresses, localhost and *.localhost are
   * always allowed; '.example.test' allows a domain and its subdomains. true: any host (when the server in
   * front checks it, as Vite does).
   */
  allowedHosts?:string[]|true;
  /** Most extra views per take (the client's limit is 8). */
  maxViews?:number;
  /** Most new takes per minute, for all clients together. */
  maxTakesPerMinute?:number;
  /** Called with one line per saved take or failure, for the dev server's terminal. */
  log?:(line:string)=>void;
  now?:()=>Date;
}

export type Request=IncomingMessage|Http2ServerRequest;
// What the handler needs from a node:http or node:http2 response.
export interface Response{writeHead(status:number,headers?:Record<string,string>):unknown;end(data?:string|Uint8Array):unknown;readonly headersSent:boolean}
export type Handler=(req:Request,res:Response,next:(error?:unknown)=>void)=>Promise<void>;

/** Reads the inbox's pairing token, or makes one: 12 letters and digits that are easy to type in a headset. */
export function pairingToken(root:string){
  ensureInbox(root);
  const file=join(root,TOKEN_FILE);
  try{const saved=readFileSync(file,'utf8').trim();if(saved.length>=8)return saved;}catch{}
  const token=Array.from({length:12},()=>TOKEN_LETTERS[randomInt(TOKEN_LETTERS.length)]).join('');
  writeFileSync(file,token+'\n',{mode:0o600});
  return token;
}

function ensureInbox(root:string){
  mkdirSync(root,{recursive:true});
  const ignore=join(root,'.gitignore');
  if(!existsSync(ignore))writeFileSync(ignore,'# Feedback takes stay on this PC.\n*\n');
}

/** Whether a Host (or :authority) value is safe from DNS rebinding: an IP, localhost, or a listed name. */
export function hostAllowed(host:string|string[]|undefined,allowed:string[]|true=[]){
  if(allowed===true)return true;
  if(typeof host!=='string'||!host)return false;
  let name:string;try{name=new URL(`http://${host}`).hostname.toLowerCase();}catch{return false;}
  if(isIP(name.replace(/^\[|\]$/g,'')))return true;
  if(name==='localhost'||name.endsWith('.localhost'))return true;
  return allowed.some(entry=>{const want=entry.toLowerCase();return want.startsWith('.')?name.endsWith(want)||name===want.slice(1):name===want;});
}

const LOOPBACK=new Set(['127.0.0.1','::1']);
const plain=(address:string|undefined)=>(address??'').replace(/^::ffff:(?=\d+\.)/,'');

async function body(req:Request,limit:number){
  const chunks:Buffer[]=[];let size=0;
  for await(const chunk of req as AsyncIterable<Buffer>){
    size+=chunk.length;
    if(size>limit)throw Object.assign(new Error('Too large'),{status:413});
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * The inbox's HTTP routes (SPEC.md) as a connect-style handler: Vite, Express, connect, or a plain
 * node:http / node:http2 server. Requests outside `base` go to `next`.
 */
export function feedbackInbox({root,transcribe,speech:speechOption,base=DEFAULT_BASE,maxViewBytes=16e6,maxVoiceBytes=30e6,token:tokenOption,trust=[],allowedHosts=[],maxViews=8,maxTakesPerMinute=30,log=()=>{},now=()=>new Date()}:InboxOptions):Handler{
  const transcriber=resolveTranscriber(transcribe),speech=resolveSpeech(speechOption);
  const prefix=base.replace(/\/$/,'');
  const ensureRoot=()=>ensureInbox(root);
  const token=tokenOption===false?null:Buffer.from(tokenOption??pairingToken(root));
  const trusted=new Set(trust.map(plain));
  const takeTimes:number[]=[];
  const misses=new Map<string,number[]>();
  const recent=(times:number[],at:number)=>{while(times.length&&at-times[0]>60_000)times.shift();return times.length;};
  /** A request from this PC (not passed on by a proxy), or from a trusted address, needs no token. */
  const needsToken=(req:Request)=>{
    const from=plain(req.socket?.remoteAddress);
    const forwarded=req.headers['x-forwarded-for']!==undefined||req.headers.forwarded!==undefined;
    return !(LOOPBACK.has(from)&&!forwarded)&&!trusted.has(from);
  };
  const tokenOk=(req:Request)=>{
    const sent=req.headers[TOKEN_HEADER];
    const given=Buffer.from(typeof sent==='string'?sent.trim():'');
    return !!token&&given.length===token.length&&timingSafeEqual(given,token);
  };
  return async(req,res,next)=>{
    const path=new URL(req.url??'/','http://localhost').pathname;
    if(path!==prefix&&!path.startsWith(`${prefix}/`))return next();
    const reply=(status:number,data:unknown)=>{
      res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});
      res.end(JSON.stringify(data));
    };
    // HTTP/2, which HTTPS dev servers usually speak, names the host in :authority instead of Host.
    const host=req.headers.host??req.headers[':authority'];
    if(!hostAllowed(host,allowedHosts))return reply(403,{error:'Host not allowed'});
    const origin=req.headers.origin;
    if(origin){
      let from:string|null=null;try{from=new URL(origin).host;}catch{}
      if(from!==host)return reply(403,{error:'Origin not allowed'});
    }
    if(token&&needsToken(req)){
      // Wrong tokens are counted per address; after 10 in a minute even the right one waits, so none can be guessed.
      const address=plain(req.socket?.remoteAddress),at=Date.now();
      const list=misses.get(address)??[];
      if(recent(list,at)>=10)return reply(429,{error:'Too many wrong tokens, wait a minute'});
      if(!tokenOk(req)){
        if(req.headers[TOKEN_HEADER]!==undefined){list.push(at);misses.set(address,list);}
        return reply(401,{error:'Pair this device: open the page address that the dev server prints, with #jxrvis=<token>'});
      }
    }
    const rest=path.slice(prefix.length);
    try{
      if(req.method==='GET'&&rest==='/health')return reply(200,{ok:true,transcriber:transcriber.name,speech:speech?.name??'none',listen:!!transcriber.listen});
      if(req.method==='POST'&&rest==='/listen'){
        // While the player talks: what they said since `from`, so the headset can hear "take a screenshot".
        if(!transcriber.listen)return reply(404,{error:'This transcriber cannot listen'});
        const type=String(req.headers['content-type']??'').split(';')[0].trim().toLowerCase();
        if(!VOICE_TYPES[type])return reply(400,{error:'Unsupported audio type'});
        const from=Math.max(0,Number(new URL(req.url??'/','http://localhost').searchParams.get('from'))||0);
        const audio=await body(req,maxVoiceBytes);
        try{return reply(200,{text:(await transcriber.listen(audio,{type,from})).trim()});}
        catch(error){log(`listen failed: ${String((error as Error)?.message??error).slice(0,200)}`);return reply(502,{error:'Transcription failed'});}
      }
      if(req.method==='POST'&&rest==='/speech'){
        if(!speech)return reply(404,{error:'No speech engine on this server'});
        let text:unknown;
        try{({text}=JSON.parse((await body(req,8000)).toString()));}catch(error){if((error as {status?:number}).status)throw error;return reply(400,{error:'The body must be JSON'});}
        if(typeof text!=='string'||!text.trim()||text.length>1000)return reply(400,{error:'text must be 1 to 1000 characters'});
        try{
          const {audio,type}=await speech.speak(text.trim());
          res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store'});res.end(audio);return;
        }catch(error){
          log(`speech failed: ${String((error as Error)?.message??error).slice(0,200)}`);
          return reply(502,{error:'Speech failed'});
        }
      }
      if(req.method==='POST'&&(rest===''||rest==='/')){
        let parsed:{image?:unknown;context?:unknown};
        const raw=await body(req,maxViewBytes);
        try{parsed=JSON.parse(raw.toString());}catch{return reply(400,{error:'The body must be JSON'});}
        const {image,context}=parsed??{};
        if(typeof image!=='string'||!IMAGE.test(image))return reply(400,{error:'The view must be a PNG or JPEG data URL'});
        if(context!==undefined&&(typeof context!=='object'||context===null||Array.isArray(context)))return reply(400,{error:'The context must be an object'});
        const arrived=Date.now();
        if(recent(takeTimes,arrived)>=maxTakesPerMinute)return reply(429,{error:'Too many takes, wait a minute'});
        takeTimes.push(arrived);
        ensureRoot();
        const at=now();let id=stamp(at);
        for(let n=2;existsSync(join(root,id));n++)id=`${stamp(at)}-${n}`;
        const folder=join(root,id);mkdirSync(folder);
        writeFileSync(join(folder,`view.${image.startsWith('data:image/png')?'png':'jpg'}`),Buffer.from(image.replace(IMAGE,''),'base64'));
        writeFileSync(join(folder,FILES.context),JSON.stringify({...(context as object|undefined),savedAt:at.toISOString(),transcriber:transcriber.name},null,2)+'\n');
        return reply(200,{id});
      }
      const route=rest.match(/^\/([^/]+)\/(voice|status|view)$/);
      if(!route)return reply(404,{error:'Not found'});
      let id:string;try{id=decodeURIComponent(route[1]);}catch{return reply(404,{error:'No such take'});}
      const folder=join(root,id);
      if(!isId(id)||!existsSync(folder))return reply(404,{error:'No such take'});
      if(req.method==='GET'&&route[2]==='status'){
        const file=join(folder,FILES.status);
        return reply(200,{status:existsSync(file)?currentStatus(readFileSync(file,'utf8')):null});
      }
      if(req.method==='POST'&&route[2]==='view'){
        if(VOICE_EXTENSIONS.some(ext=>existsSync(join(folder,`voice.${ext}`))))return reply(409,{error:'The take is finished'});
        let parsed:{image?:unknown;seconds?:unknown;trigger?:unknown;head?:unknown};
        const raw=await body(req,maxViewBytes);
        try{parsed=JSON.parse(raw.toString());}catch{return reply(400,{error:'The body must be JSON'});}
        const {image,seconds,trigger,head}=parsed??{};
        if(typeof image!=='string'||!IMAGE.test(image))return reply(400,{error:'The view must be a PNG or JPEG data URL'});
        if(readdirSync(folder).filter(f=>/^view-\d+\.(png|jpg)$/.test(f)).length>=maxViews)return reply(409,{error:'No more views for this take'});
        const ext=image.startsWith('data:image/png')?'png':'jpg';
        let n=2;while(VIEW_EXTENSIONS.some(e=>existsSync(join(folder,`view-${n}.${e}`))))n++;
        const file=`view-${n}.${ext}`;
        writeFileSync(join(folder,file),Buffer.from(image.replace(IMAGE,''),'base64'));
        const list=join(folder,FILES.views);
        let views:Record<string,unknown>[]=[];
        try{views=JSON.parse(readFileSync(list,'utf8'));}catch{
          const first=VIEW_EXTENSIONS.map(e=>`view.${e}`).find(f=>existsSync(join(folder,f)));
          if(first)views=[{file:first,seconds:0,trigger:'start'}];
        }
        views.push({file,...(typeof seconds==='number'&&Number.isFinite(seconds)?{seconds:+seconds.toFixed(1)}:{}),trigger:trigger==='voice'||trigger==='button'?trigger:'button',...(head&&typeof head==='object'?{head}:{})});
        writeFileSync(list,JSON.stringify(views,null,2)+'\n');
        return reply(200,{id,file});
      }
      if(req.method==='POST'&&route[2]==='voice'){
        const type=String(req.headers['content-type']??'').split(';')[0].trim().toLowerCase();
        const ext=VOICE_TYPES[type];
        if(!ext)return reply(400,{error:'Unsupported audio type'});
        if(VOICE_EXTENSIONS.some(e=>existsSync(join(folder,`voice.${e}`))))return reply(409,{error:'The take already has its voice'});
        const audio=await body(req,maxVoiceBytes);
        try{writeFileSync(join(folder,`voice.${ext}`),audio,{flag:'wx'});}
        catch{return reply(409,{error:'The take already has its voice'});}
        try{
          const text=await transcriber.transcribe(audio,{type,id});
          if(text===null){log(`take ${id}: voice saved (no transcriber)`);return reply(200,{id,transcript:null});}
          const transcript=text.trim();
          writeFileSync(join(folder,FILES.transcript),transcript+'\n');
          log(`take ${id}: ${transcript||'(empty transcript)'}`);
          return reply(200,{id,transcript});
        }catch(error){
          const message=String((error as Error)?.message??error).slice(0,200);
          log(`take ${id}: voice saved, transcription failed: ${message}`);
          return reply(200,{id,transcript:null,error:'Transcription failed'});
        }
      }
      return reply(404,{error:'Not found'});
    }catch(error){
      const status=(error as {status?:number}).status;
      if(status)return reply(status,{error:String((error as Error).message).slice(0,200)});
      log(`request failed: ${String((error as Error)?.message??error).slice(0,200)}`);
      return reply(400,{error:'Request failed'});
    }
  };
}
