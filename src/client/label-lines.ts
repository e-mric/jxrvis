/**
 * The lines a status label shows for `text`: one line of up to `line` characters, or two lines of up to
 * `line + 8` each (drawn smaller), split at a space when it can and cut with … past two lines.
 */
export function wrap(text:string,line=34):string[]{
  const most=line+8;
  text=text.replace(/\s+/g,' ').trim();
  if(text.length<=line)return [text];
  const cut=text.lastIndexOf(' ',most);
  const first=cut>line/2?text.slice(0,cut):text.slice(0,most),rest=text.slice(first.length).trim();
  return [first,rest.length>most?`${rest.slice(0,most-1)}…`:rest];
}
