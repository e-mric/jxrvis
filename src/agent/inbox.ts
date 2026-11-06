import {existsSync,readFileSync,readdirSync,renameSync,statSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {FILES,STATUS_MAX,STATUS_PREFIXES,VIEW_EXTENSIONS,VOICE_EXTENSIONS,currentStatus,isFinal,isId,sortIds,statusPrefix} from '../spec.ts';

/** One take as an agent sees it. Paths are absolute. */
export interface Take{
  id:string;
  folder:string;
  view:string|null;
  voice:string|null;
  transcript:string|null;
  context:Record<string,unknown>|null;
  /** The context's one-phrase summary, if the app gave one. */
  summary:string|null;
  /** The current status (last line of status.txt) and every line so far. */
  status:string|null;
  statusLines:string[];
  /** Done or Skipped: the agent has finished with it. */
  finished:boolean;
  /** When this take answers an agent's question: the asking take's id, and the question. */
  replyTo:string|null;
  question:string|null;
}

const read=(file:string)=>{try{return readFileSync(file,'utf8');}catch{return null;}};
const first=(folder:string,name:string,extensions:string[])=>extensions.map(ext=>join(folder,`${name}.${ext}`)).find(existsSync)??null;

/** Take ids in the inbox, oldest first. Anything that is not a take folder is ignored. */
export function takeIds(root:string){
  if(!existsSync(root))return [];
  return sortIds(readdirSync(root,{withFileTypes:true}).filter(e=>e.isDirectory()&&isId(e.name)).map(e=>e.name));
}

export function readTake(root:string,id:string):Take|null{
  if(!isId(id))return null;
  const folder=resolve(root,id);
  if(!existsSync(folder))return null;
  let context:Record<string,unknown>|null=null;
  try{context=JSON.parse(read(join(folder,FILES.context))??'null');}catch{}
  const statusText=read(join(folder,FILES.status));
  const status=currentStatus(statusText);
  return {
    id,folder,
    view:first(folder,'view',VIEW_EXTENSIONS),
    voice:first(folder,'voice',VOICE_EXTENSIONS),
    transcript:read(join(folder,FILES.transcript))?.trim()??null,
    context,
    summary:typeof context?.summary==='string'?context.summary:null,
    status,
    statusLines:(statusText??'').split(/\r?\n/).map(l=>l.trim()).filter(Boolean),
    finished:isFinal(status),
    replyTo:typeof context?.replyTo==='string'&&isId(context.replyTo)?context.replyTo:null,
    question:typeof context?.question==='string'?context.question:null,
  };
}

/** Every take, newest first. `pending`: only those without a status yet. */
export function listTakes(root:string,{pending=false,limit=Infinity}:{pending?:boolean;limit?:number}={}){
  const takes:Take[]=[];
  for(const id of takeIds(root).reverse()){
    const take=readTake(root,id);
    if(!take||(pending&&take.status))continue;
    takes.push(take);
    if(takes.length>=limit)break;
  }
  return takes;
}

/**
 * Writes a status line for a take (SPEC.md "Status lines"). Appends by default, so status.txt keeps the
 * take's history; the current status is always the last line. Written via a temporary file and a rename,
 * so the headset never reads half a line. Returns the line and a warning when it is long.
 */
export function setStatus(root:string,id:string,text:string,{replace=false}:{replace?:boolean}={}){
  if(!isId(id))throw new Error(`"${id}" is not a take id`);
  const folder=resolve(root,id);
  if(!existsSync(folder))throw new Error(`No take ${id} in ${root}`);
  const line=text.replace(/\s+/g,' ').trim();
  if(!statusPrefix(line))throw new Error(`A status starts with ${STATUS_PREFIXES.map(p=>`"${p}:"`).join(', ')}; got "${line.slice(0,40)}"`);
  const file=join(folder,FILES.status),before=replace?'':read(file)??'';
  const temp=`${file}.${process.pid}.tmp`;
  writeFileSync(temp,`${before}${before&&!before.endsWith('\n')?'\n':''}${line}\n`);
  renameSync(temp,file);
  return {line,warning:line.length>STATUS_MAX?`${line.length} characters; the headset shows about ${STATUS_MAX}`:undefined};
}

/**
 * When a take is ready for an agent: once its transcript is in; or once its voice is in when the server
 * has no transcriber; or `wait` seconds after the voice (transcription failed or is slow) or after the
 * view (the voice never came).
 */
export function isReady(take:Take,wait:number,now=Date.now()){
  if(take.transcript!==null)return true;
  if(take.voice&&take.context?.transcriber==='none')return true;
  const since=take.voice??take.view??take.folder;
  try{return now-statSync(since).mtimeMs>=wait*1000;}catch{return false;}
}

/**
 * Finds takes as they become ready. Takes already in the inbox when it starts are left alone unless
 * `includeExisting` (then only those without a status). Each take is reported once.
 */
export class TakeTracker{
  private known=new Set<string>();
  private waiting=new Set<string>();
  readonly root:string;
  readonly wait:number;
  constructor(root:string,{wait=60,includeExisting=false}:{wait?:number;includeExisting?:boolean}={}){
    this.root=root;this.wait=wait;
    for(const id of takeIds(root)){
      this.known.add(id);
      if(includeExisting&&!readTake(root,id)?.status)this.waiting.add(id);
    }
  }
  get pending(){return this.waiting.size;}
  /** The takes that became ready since the last call, oldest first. */
  poll(now=Date.now()):Take[]{
    for(const id of takeIds(this.root))if(!this.known.has(id)){this.known.add(id);this.waiting.add(id);}
    const ready:Take[]=[];
    for(const id of sortIds([...this.waiting])){
      const take=readTake(this.root,id);
      if(!take){this.waiting.delete(id);continue;}
      if(isReady(take,this.wait,now)){this.waiting.delete(id);ready.push(take);}
    }
    return ready;
  }
}

/** The watcher's one line for a take: `FEEDBACK <id> [summary]: what was said`. */
export function describe(take:Take){
  const said=(take.transcript!==null?(take.transcript||'(silence)')
    :take.voice?`(no transcript: listen to ${take.voice})`:'(no voice: view and context only)').replace(/\s+/g,' ');
  // An answer to the agent's question: carry on with the asking take, which the headset follows.
  if(take.replyTo)return `ANSWER ${take.id} to ${take.replyTo}${take.question?` [${take.question}]`:''}: ${said}`;
  return `FEEDBACK ${take.id}${take.summary?` [${take.summary}]`:''}: ${said}`;
}
