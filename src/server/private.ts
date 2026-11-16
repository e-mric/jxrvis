import {realpathSync} from 'node:fs';
import {dirname,isAbsolute,relative,resolve} from 'node:path';

const WINDOWS=process.platform==='win32';

/**
 * The folders a web server must never serve as files: the inbox (takes, the pairing token) and the fix
 * notes next to it (`feedback/notes` beside `feedback/inbox`). The agent reads them from disk; no page needs them.
 */
export function privateFolders(inbox:string,webRoot?:string){
  const folders=[resolve(inbox)];
  const notes=resolve(dirname(resolve(inbox)),'notes');
  // Only when the inbox has a folder of its own: with the inbox at the web root's top, its parent is the root.
  if(!webRoot||resolve(dirname(resolve(inbox)))!==resolve(webRoot))folders.push(notes);
  return folders;
}

/** The real path of a file or folder (long names, symlinks resolved), or the path itself when it does not exist. */
function real(path:string){try{return realpathSync.native(path);}catch{return path;}}

/** On Windows "inbox." and "inbox " name the folder "inbox", and "file::$DATA" names "file". */
function windowsName(path:string){
  return WINDOWS?path.split(/[\\/]/).map(part=>/^[A-Za-z]:$/.test(part)?part:part.replace(/:.*$/,'').replace(/[. ]+$/,'')||part).join('/'):path;
}

function inside(file:string,folder:string){
  const rel=relative(folder,file);
  return rel===''||(!rel.startsWith('..')&&!isAbsolute(rel));
}

/**
 * Whether a request URL would read a file inside one of `folders`: as a path under the web root, or through
 * Vite's /@fs/ and /@id/ prefixes. Undecodable URLs count as private.
 */
export function requestsPrivate(url:string|undefined,webRoot:string,folders:string[]){
  let path:string;
  try{path=decodeURIComponent(new URL(url??'/','http://localhost').pathname);}catch{return true;}
  const candidates=[resolve(webRoot,`.${windowsName(path)}`)];
  for(const prefix of ['/@fs/','/@id/']){
    if(!path.startsWith(prefix))continue;
    let file=path.slice(prefix.length-1);
    if(WINDOWS&&/^\/[A-Za-z]:/.test(file))file=file.slice(1);
    candidates.push(resolve(windowsName(file)));
  }
  const realFolders=folders.map(f=>[resolve(f),real(resolve(f))]).flat();
  return candidates.some(file=>{
    const files=[file,real(file),real(dirname(file))];
    return files.some(f=>realFolders.some(folder=>inside(f,folder)));
  });
}
