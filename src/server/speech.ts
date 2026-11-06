/**
 * Optional text-to-speech on the dev PC, for headsets whose browser has no voices of its own. The client
 * POSTs a status line to {base}/speech and plays the audio. Without one, clients use their platform's voice.
 */
export type Speak=(text:string)=>Promise<{audio:Uint8Array;type:string}>;
export interface Speech{name:string;speak:Speak}

export const SPEECH_TYPES=['audio/wav','audio/x-wav','audio/mpeg','audio/ogg','audio/webm'];

/**
 * A speech server on this PC: POST {"text":"…"} as JSON, get audio back (any of SPEECH_TYPES).
 * Piper, Kokoro or a cloud-free TTS of your choice behind a ten-line HTTP wrapper fits.
 */
export function httpSpeech(url:string,{timeoutMs=30_000,name='http'}:{timeoutMs?:number;name?:string}={}):Speech{
  return {name,async speak(text){
    const reply=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text}),signal:AbortSignal.timeout(timeoutMs)});
    if(!reply.ok)throw new Error(`speech server answered ${reply.status}: ${(await reply.text()).slice(0,120)}`);
    const type=(reply.headers.get('content-type')??'').split(';')[0].trim().toLowerCase();
    if(!SPEECH_TYPES.includes(type))throw new Error(`speech server answered ${type||'no type'}, not audio`);
    return {audio:new Uint8Array(await reply.arrayBuffer()),type};
  }};
}

export type SpeechOption=Speech|Speak|string|null|undefined;

/** 'none' (or nothing) → no speech route; an http(s) URL → httpSpeech; a function → used as is. */
export function resolveSpeech(option:SpeechOption):Speech|null{
  if(!option||option==='none')return null;
  if(typeof option==='string'){
    if(!/^https?:\/\//.test(option))throw new Error(`Speech is 'none', a URL or a function, not "${option}"`);
    return httpSpeech(option);
  }
  if(typeof option==='function')return {name:option.name||'custom',speak:option};
  return option;
}
