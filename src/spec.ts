// The file and HTTP contract from SPEC.md, as constants every part of the loop shares.
// Nothing here touches the file system or the DOM, so the browser client can import it too.

/** A take's folder name: the server's local time when the view arrived, plus -2, -3… on a clash. */
export const ID=/^\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d(-\d+)?$/;
export const DEFAULT_BASE='/api/feedback';
export const DEFAULT_INBOX='feedback/inbox';

export const FILES={context:'context.json',transcript:'transcript.txt',status:'status.txt'} as const;
/** Audio Content-Types the inbox accepts, and the extension each is saved with. */
export const VOICE_TYPES:Record<string,string>={'audio/webm':'webm','audio/ogg':'ogg','audio/mp4':'m4a','audio/mpeg':'mp3','audio/wav':'wav','audio/x-wav':'wav'};
export const VOICE_EXTENSIONS=[...new Set(Object.values(VOICE_TYPES))];
export const VIEW_EXTENSIONS=['png','jpg'];

export const STATUS_PREFIXES=['On it','Question','Done','Skipped'] as const;
export type StatusPrefix=typeof STATUS_PREFIXES[number];
/** A status that ends a take: the headset stops following it. */
export const FINAL_PREFIXES:readonly StatusPrefix[]=['Done','Skipped'];
/** Longest status line that still fits the headset label comfortably. */
export const STATUS_MAX=70;

export function isId(id:string){return ID.test(id);}

/** The id for a take whose view arrives at `date` (without the -N suffix). */
export function stamp(date:Date){
  const p=(n:number)=>String(n).padStart(2,'0');
  return `${date.getFullYear()}-${p(date.getMonth()+1)}-${p(date.getDate())}_${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}`;
}

/** The current status in the text of a status.txt: its last non-empty line, or null. */
export function currentStatus(text:string|null|undefined):string|null{
  const lines=(text??'').split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
  return lines.at(-1)??null;
}

/** The prefix a status line starts with, if it is one of the four. */
export function statusPrefix(line:string):StatusPrefix|null{
  return STATUS_PREFIXES.find(prefix=>line.startsWith(`${prefix}:`))??null;
}

export function isFinal(line:string|null){
  const prefix=line?statusPrefix(line):null;
  return !!prefix&&FINAL_PREFIXES.includes(prefix);
}

/** Ids sorted oldest first: by time, then by suffix (…07 before …07-2 before …07-10). */
export function sortIds(ids:string[]){
  const key=(id:string)=>{const [, base, n]=id.match(/^(.{19})(?:-(\d+))?$/)??[];return [base??id,Number(n??1)] as const;};
  return [...ids].sort((a,b)=>{const [x,i]=key(a),[y,j]=key(b);return x<y?-1:x>y?1:i-j;});
}
