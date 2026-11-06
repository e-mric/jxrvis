/**
 * Turns a take's voice into text. The inbox calls `transcribe` once per take, after the voice is saved;
 * a null result means "no transcript" (the voice file is the only record), a thrown error is reported to
 * the headset and the voice is kept. Anything that implements this can be plugged in.
 */
export type Transcribe=(audio:Buffer,info:{type:string;id:string})=>Promise<string|null>;
/**
 * Optional: the text of the recording so far, from `from` seconds to the end, while the player is still
 * talking. The headset uses it to hear "take a screenshot". It must be quick: it runs every second or two.
 */
export type Listen=(audio:Buffer,info:{type:string;from:number})=>Promise<string>;
export interface Transcriber{name:string;transcribe:Transcribe;listen?:Listen}

/** Voice only: takes keep their voice file and get no transcript. */
export const noTranscriber:Transcriber={name:'none',transcribe:async()=>null};

async function post(url:string,audio:Buffer,type:string,timeoutMs:number){
  const reply=await fetch(url,{method:'POST',headers:{'Content-Type':type||'application/octet-stream'},body:new Uint8Array(audio),signal:AbortSignal.timeout(timeoutMs)});
  if(!reply.ok)throw new Error(`transcriber answered ${reply.status}: ${(await reply.text()).slice(0,120)}`);
  const {text}=await reply.json() as {text?:unknown};
  if(typeof text!=='string')throw new Error('transcriber answered without text');
  return text;
}

/**
 * A transcription server on this PC, such as tools/whisper-server.py: POST the audio, get {"text":"…"}.
 * Long takes can need minutes where Whisper runs on a CPU, hence the generous timeout. With `listen`
 * (default true), the server must also accept `?from=<seconds>` and transcribe only from there on, as
 * whisper-server.py does.
 */
export function httpTranscriber(url:string,{timeoutMs=240_000,name='http',listen=true}:{timeoutMs?:number;name?:string;listen?:boolean}={}):Transcriber{
  return {
    name,
    transcribe:(audio,{type})=>post(url,audio,type,timeoutMs),
    ...(listen?{listen:(audio:Buffer,{type,from}:{type:string;from:number})=>{
      const at=new URL(url);if(from>0)at.searchParams.set('from',from.toFixed(2));
      return post(at.href,audio,type,15_000);
    }}:{}),
  };
}

export type TranscriberOption=Transcriber|Transcribe|string|null|undefined;

/** 'none' (or nothing) → voice only; an http(s) URL → httpTranscriber; a function → used as is. */
export function resolveTranscriber(option:TranscriberOption):Transcriber{
  if(!option||option==='none')return noTranscriber;
  if(typeof option==='string'){
    if(!/^https?:\/\//.test(option))throw new Error(`A transcriber is 'none', a URL or a function, not "${option}"`);
    return httpTranscriber(option);
  }
  if(typeof option==='function')return {name:option.name||'custom',transcribe:option};
  return option;
}
