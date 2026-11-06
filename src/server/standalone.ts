import {createReadStream,existsSync,readFileSync,statSync} from 'node:fs';
import http from 'node:http';
import http2 from 'node:http2';
import type {AddressInfo} from 'node:net';
import {extname,join,resolve,sep} from 'node:path';
import {feedbackInbox,type InboxOptions,type Request,type Response} from './inbox.ts';

export interface ServerOptions extends InboxOptions{
  /** A folder of static files to serve next to the inbox (a built WebXR app, the example page). */
  static?:string;
  /** PEM files for HTTPS. Without them the server speaks plain HTTP (fine for localhost and adb reverse). */
  cert?:string;
  key?:string;
}

const TYPES:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.glb':'model/gltf-binary','.gltf':'model/gltf+json','.wasm':'application/wasm','.ico':'image/x-icon','.webp':'image/webp','.mp3':'audio/mpeg','.ogg':'audio/ogg','.wav':'audio/wav','.mp4':'video/mp4','.ktx2':'image/ktx2','.bin':'application/octet-stream','.txt':'text/plain; charset=utf-8'};

function serveStatic(folder:string,req:Request,res:Response){
  const root=resolve(folder);
  let path:string;try{path=decodeURIComponent(new URL(req.url??'/','http://localhost').pathname);}catch{path='/';}
  let file=resolve(join(root,path));
  if(file!==root&&!file.startsWith(root+sep)){res.writeHead(403);res.end();return;}
  if(existsSync(file)&&statSync(file).isDirectory())file=join(file,'index.html');
  if(!existsSync(file)||!statSync(file).isFile()){res.writeHead(404,{'Content-Type':'text/plain'});res.end('Not found');return;}
  res.writeHead(200,{'Content-Type':TYPES[extname(file).toLowerCase()]??'application/octet-stream','Cache-Control':'no-cache'});
  if(req.method==='HEAD'){res.end();return;}
  createReadStream(file).pipe(res as unknown as NodeJS.WritableStream);
}

/**
 * The inbox as a server of its own, for projects whose dev server is not Vite (or for native clients).
 * With cert and key it is HTTPS over HTTP/2 (HTTP/1.1 allowed), as browsers need for the microphone.
 */
export function createFeedbackServer(options:ServerOptions){
  const handle=feedbackInbox(options);
  const listener=(req:Request,res:Response)=>{
    void handle(req,res,()=>{
      if(options.static&&(req.method==='GET'||req.method==='HEAD'))return serveStatic(options.static,req,res);
      res.writeHead(404,{'Content-Type':'text/plain'});res.end('Not found');
    }).catch(error=>{if(!res.headersSent)res.writeHead(500);res.end(String(error));});
  };
  if(!!options.cert!==!!options.key)throw new Error('HTTPS needs both a certificate and a key');
  const server=options.cert&&options.key
    ?http2.createSecureServer({cert:readFileSync(options.cert),key:readFileSync(options.key),allowHTTP1:true},listener)
    :http.createServer(listener);
  return {
    server,
    secure:!!options.cert,
    listen(port=0,host='127.0.0.1'){
      return new Promise<{port:number;url:string}>((ok,fail)=>{
        server.once('error',fail);
        server.listen(port,host,()=>{
          const actual=(server.address() as AddressInfo).port;
          ok({port:actual,url:`${options.cert?'https':'http'}://${host==='0.0.0.0'?'localhost':host}:${actual}`});
        });
      });
    },
    close(){return new Promise<void>(ok=>server.close(()=>ok()));},
  };
}
