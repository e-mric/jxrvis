/**
 * Turns a take's voice into text. The inbox calls `transcribe` once per take, after the voice is saved;
 * a null result means "no transcript" (the voice file is the only record), a thrown error is reported to
 * the headset and the voice is kept. Anything that implements this can be plugged in.
 */
export type Transcribe=(audio:Buffer,info:{type:string;id:string})=>Promise<string|null>;
export interface Transcriber{name:string;transcribe:Transcribe}

/** Voice only: takes keep their voice file and get no transcript. */
export const noTranscriber:Transcriber={name:'none',transcribe:async()=>null};

/**
 * A transcription server on this PC, such as tools/whisper-server.py: POST the audio, get {"text":"…"}.
 * Long takes can need minutes where Whisper runs on a CPU, hence the generous timeout.
 */
export function httpTranscriber(url:string,{timeoutMs=240_000,name='http'}:{timeoutMs?:number;name?:string}={}):Transcriber{
  return {name,async transcribe(audio,{type}){
    const reply=await fetch(url,{method:'POST',headers:{'Content-Type':type||'application/octet-stream'},body:new Uint8Array(audio),signal:AbortSignal.timeout(timeoutMs)});
    if(!reply.ok)throw new Error(`transcriber answered ${reply.status}: ${(await reply.text()).slice(0,120)}`);
    const {text}=await reply.json() as {text?:unknown};
    if(typeof text!=='string')throw new Error('transcriber answered without text');
    return text;
  }};
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
