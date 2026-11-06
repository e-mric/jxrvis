import {DEFAULT_BASE,isFinal} from '../spec.ts';

/** What a snapshot gives: the eye view as a PNG/JPEG data URL, plus what the adapter knows (xr, head pose). */
export type Snapshot={image:string;details?:Record<string,unknown>};
export type FeedbackEvent='start'|'saved'|'status'|'error';

/** The part of MediaRecorder the client uses, so tests and native shims can stand in for it. */
export interface RecorderLike{
  readonly mimeType:string;
  ondataavailable:((event:{data:Blob})=>void)|null;
  onstop:(()=>void)|null;
  start(timeslice?:number):void;
  stop():void;
}

export interface Timing{
  /** After a toggle start, seconds before the snapshot, so the player can look back from the menu. */
  lookUp:number;
  /** Takes shorter than this (seconds) are dropped. */
  shortest:number;
  /** A recording stops by itself after this many seconds. */
  longest:number;
  /** How often (seconds) and for how long the client follows a saved take's status. */
  followEvery:number;
  followFor:number;
}

export interface ClientOptions{
  /** Where the inbox routes are (SPEC.md); same origin by default. */
  base?:string;
  /** The player's view right now. The three.js adapter supplies one; any engine can. */
  snapshot():Snapshot|string|Promise<Snapshot|string>;
  /** What the host app is doing. `summary` (a short phrase) goes to the top level, the rest under `app`. */
  context?():Record<string,unknown>;
  /** Shows a message to the player for `seconds` (Infinity: until the next one). */
  show(text:string,seconds:number):void;
  /** For short sounds on start, save, each new status and errors. */
  sound?(event:FeedbackEvent):void;
  /** Called when recording starts or stops, e.g. to relabel a menu button. */
  changed?(recording:boolean):void;
  /** Shown before each status line: "Agent: Done: …". */
  agentName?:string;
  microphone?():Promise<MediaStream>;
  recorder?(stream:MediaStream):RecorderLike;
  fetch?:typeof fetch;
  timing?:Partial<Timing>;
  /** Keep the page's last console errors and send them with each take (default true in a browser). */
  captureErrors?:boolean;
}

export const DEFAULT_TIMING:Timing={lookUp:1.5,shortest:.4,longest:90,followEvery:3,followFor:20*60};

type Take={held:boolean;snap?:Promise<Snapshot>;recorder:RecorderLike;chunks:Blob[];started:number;timers:ReturnType<typeof setTimeout>[]};

const now=()=>performance.now();
const asSnapshot=(value:Snapshot|string):Snapshot=>typeof value==='string'?{image:value}:value;

/**
 * Keeps the page's most recent console errors, uncaught errors and unhandled rejections.
 * Returns the list getter and a function that puts everything back.
 */
export function watchErrors(keep=20){
  const errors:string[]=[];
  const add=(text:string)=>{errors.push(text.slice(0,300));if(errors.length>keep)errors.shift();};
  const original=console.error;
  console.error=(...args:unknown[])=>{add(args.map(a=>a instanceof Error?`${a.name}: ${a.message}`:String(a)).join(' '));original.apply(console,args);};
  const onError=(event:ErrorEvent)=>add(`${event.message} @ ${event.filename}:${event.lineno}`);
  const onRejection=(event:PromiseRejectionEvent)=>add(`Unhandled: ${String(event.reason)}`);
  const target=typeof window==='undefined'?undefined:window;
  target?.addEventListener('error',onError);target?.addEventListener('unhandledrejection',onRejection);
  return {
    recent:()=>[...errors],
    dispose(){console.error=original;target?.removeEventListener('error',onError);target?.removeEventListener('unhandledrejection',onRejection);},
  };
}

/**
 * The headset side of the loop, without any 3D: start and stop takes, record the voice, upload the view
 * and the voice, then follow what the agent says about the take. Wire `press`/`release` to a hold-to-talk
 * button and `toggle` to a menu button; the adapters do that for you.
 */
export function createFeedbackClient(options:ClientOptions){
  const base=(options.base??DEFAULT_BASE).replace(/\/$/,'');
  const timing={...DEFAULT_TIMING,...options.timing};
  const http=options.fetch??((...args:Parameters<typeof fetch>)=>fetch(...args));
  const agent=options.agentName??'Agent';
  const errors=(options.captureErrors??typeof window!=='undefined')?watchErrors():undefined;
  const microphone=options.microphone??(()=>navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true}}));
  const recorder=options.recorder??((stream:MediaStream)=>new MediaRecorder(stream) as unknown as RecorderLike);
  const show=(text:string,seconds=Infinity)=>options.show(text,seconds);

  let healthy:Promise<boolean>|undefined,stream:Promise<MediaStream>|undefined;
  let take:Take|undefined,starting=false,releasedEarly=false,disposed=false;
  const following=new Set<AbortController>();

  const available=()=>{
    healthy??=http(`${base}/health`,{signal:AbortSignal.timeout(3000)}).then(r=>r.ok,()=>false);
    return healthy.then(ok=>{if(!ok)healthy=undefined;return ok;});
  };

  function capture():Promise<Snapshot>{
    // The host's context is read at the same moment as the view, so both describe one instant.
    const host=options.context?.()??{};
    return Promise.resolve().then(()=>options.snapshot()).then(asSnapshot).then(shot=>{
      const {summary,...app}=host;
      return {image:shot.image,details:{
        ...(typeof summary==='string'?{summary}:{}),
        ...shot.details,
        app,
        url:typeof location==='undefined'?undefined:location.href,
        userAgent:typeof navigator==='undefined'?undefined:navigator.userAgent,
        recentErrors:errors?.recent()??[],
      }};
    });
  }

  async function start(held:boolean){
    if(take||starting||disposed)return;
    starting=true;releasedEarly=false;
    try{
      if(!await available()){show('Feedback needs the dev server on the PC',3);options.sound?.('error');return;}
      // A hold is about what is in front of the eyes now, before the microphone has even opened.
      const snap=held?capture():undefined;
      snap?.catch(()=>{});
      let media:MediaStream;
      try{stream??=microphone();media=await stream;}
      catch{stream=undefined;show('The microphone is not available',3);options.sound?.('error');return;}
      const current:Take={held,snap,recorder:recorder(media),chunks:[],started:now(),timers:[]};
      current.recorder.ondataavailable=event=>{if(event.data.size)current.chunks.push(event.data);};
      current.recorder.start(500);
      take=current;
      if(!held)current.timers.push(setTimeout(()=>{
        if(take!==current||current.snap)return;
        current.snap=capture();current.snap.catch(()=>{});
        show('● Recording… press again to stop');
      },timing.lookUp*1000));
      current.timers.push(setTimeout(()=>{if(take===current)stop();},timing.longest*1000));
      options.sound?.('start');
      show(held?'● Recording… let go to save':'Look at it… snapshot in a moment');
    }finally{starting=false;options.changed?.(!!take);}
    if(held&&releasedEarly)stop();
  }

  function stop(){
    const current=take;if(!current)return;
    take=undefined;current.timers.forEach(clearTimeout);options.changed?.(false);
    const snap=current.snap??capture();
    const seconds=(now()-current.started)/1000;
    current.recorder.onstop=()=>{
      if(seconds<timing.shortest){show('Too short, not saved',2);return;}
      const voice=new Blob(current.chunks,{type:current.recorder.mimeType||'audio/webm'});
      void snap.then(shot=>send(shot,voice,seconds),error=>{console.error('Feedback snapshot failed:',error);show('Feedback could not be saved',4);});
    };
    current.recorder.stop();
  }

  /** Uploads one take (view first, then voice) and returns its id and transcript. */
  async function submit(shot:Snapshot,voice:Blob,seconds?:number){
    const context={...shot.details,...(seconds===undefined?{}:{seconds:+seconds.toFixed(1)})};
    const saved=await http(base,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({image:shot.image,context})});
    if(!saved.ok)throw new Error(`view upload answered ${saved.status}: ${await saved.text()}`);
    const {id}=await saved.json() as {id:string};
    const heard=await http(`${base}/${encodeURIComponent(id)}/voice`,{method:'POST',headers:{'Content-Type':voice.type||'audio/webm'},body:voice});
    if(!heard.ok)throw new Error(`voice upload answered ${heard.status}: ${await heard.text()}`);
    const {transcript,error}=await heard.json() as {transcript:string|null;error?:string};
    return {id,transcript,error};
  }

  async function send(shot:Snapshot,voice:Blob,seconds:number){
    show('Saving feedback…');
    try{
      const {id,transcript,error}=await submit(shot,voice,seconds);
      options.sound?.('saved');
      show(transcript?`Saved: “${transcript}”`:error?'Saved; transcript failed':'Saved (voice only)',5);
      void follow(id);
    }catch(error){
      console.error('Feedback could not be saved:',error);
      options.sound?.('error');
      show('Feedback could not be saved',4);
    }
  }

  /**
   * Polls a take's status until it starts with Done or Skipped, or `followFor` runs out, and shows each
   * new line as "<agent>: <status>". Resolves with the last status seen.
   */
  async function follow(id:string){
    const stop=new AbortController();following.add(stop);
    let last:string|null=null;const until=now()+timing.followFor*1000;
    try{
      while(now()<until&&!stop.signal.aborted){
        await new Promise(resolve=>setTimeout(resolve,timing.followEvery*1000));
        if(stop.signal.aborted)break;
        try{
          const {status}=await (await http(`${base}/${encodeURIComponent(id)}/status`,{signal:stop.signal})).json() as {status:string|null};
          if(status&&status!==last){last=status;options.sound?.('status');show(`${agent}: ${status}`,7);}
          if(isFinal(status))break;
        }catch{/* the dev server restarting: try again next time */}
      }
    }finally{following.delete(stop);}
    return last;
  }

  return {
    /** A hold-to-talk button went down: the view is taken now. */
    press(){void start(true);},
    /** The hold-to-talk button came up. */
    release(){if(take?.held)stop();else if(starting)releasedEarly=true;},
    /** A menu button: starts (view taken `lookUp` seconds later) or stops. A held take also stops. */
    toggle(){if(take)stop();else void start(false);},
    /** Same as the hold button, except that it also stops a toggled take (as B/Y do on Quest). */
    holdDown(){if(take&&!take.held)stop();else void start(true);},
    get recording(){return !!take||starting;},
    submit:(shot:Snapshot|string,voice:Blob,seconds?:number)=>submit(asSnapshot(shot),voice,seconds),
    follow,
    dispose(){
      disposed=true;
      if(take){take.timers.forEach(clearTimeout);take.recorder.onstop=null;try{take.recorder.stop();}catch{}take=undefined;}
      following.forEach(c=>c.abort());errors?.dispose();
      void stream?.then(s=>s.getTracks().forEach(t=>t.stop()),()=>{});
    },
  };
}
export type FeedbackClient=ReturnType<typeof createFeedbackClient>;

/** Hold a key (F by default) to talk. Ignored while typing in a text field. Returns a function that unbinds. */
export function bindKey(client:Pick<FeedbackClient,'holdDown'|'release'>,{key='f',target=window as Pick<Window,'addEventListener'|'removeEventListener'>}={}){
  const typing=()=>{const el=typeof document==='undefined'?null:document.activeElement;return !!el&&(el.tagName==='INPUT'||el.tagName==='TEXTAREA'||(el as HTMLElement).isContentEditable);};
  const down=(event:KeyboardEvent)=>{if(event.key.toLowerCase()===key&&!event.repeat&&!typing())client.holdDown();};
  const up=(event:KeyboardEvent)=>{if(event.key.toLowerCase()===key)client.release();};
  target.addEventListener('keydown',down as EventListener);target.addEventListener('keyup',up as EventListener);
  return ()=>{target.removeEventListener('keydown',down as EventListener);target.removeEventListener('keyup',up as EventListener);};
}
