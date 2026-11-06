import {resolve} from 'node:path';
import {DEFAULT_INBOX} from '../spec.ts';
import {feedbackInbox,type InboxOptions} from './inbox.ts';

export interface VitePluginOptions extends Omit<InboxOptions,'root'>{
  /** The inbox folder, relative to Vite's root. Default feedback/inbox. */
  inbox?:string;
}

// Structural types, so this package does not need Vite installed to build.
type Middlewares={use(handler:(req:any,res:any,next:(error?:unknown)=>void)=>void):unknown};
type DevServer={config:{root:string;logger:{info(message:string,options?:object):void}};middlewares:Middlewares};

/**
 * Serves the feedback inbox (SPEC.md) from the Vite dev server and `vite preview`, the server the headset
 * page already comes from, so the routes share its origin and its HTTPS. Not part of production builds.
 */
export function jxrvis(options:VitePluginOptions={}){
  const install=(server:DevServer)=>{
    const root=resolve(server.config.root,options.inbox??DEFAULT_INBOX);
    const log=options.log??((line:string)=>server.config.logger.info(`[jXRvis] ${line}`,{timestamp:true}));
    const handle=feedbackInbox({...options,root,log});
    server.middlewares.use((req,res,next)=>{void handle(req,res,next).catch(next);});
  };
  return {
    name:'jxrvis',
    configureServer:install,
    configurePreviewServer:install,
  };
}

export default jxrvis;
