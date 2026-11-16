import {resolve} from 'node:path';
import {DEFAULT_INBOX} from '../spec.ts';
import {feedbackInbox,pairingToken,type InboxOptions} from './inbox.ts';

export interface VitePluginOptions extends Omit<InboxOptions,'root'>{
  /** The inbox folder, relative to Vite's root. Default feedback/inbox. */
  inbox?:string;
}

// Structural types, so this package does not need Vite installed to build.
type Middlewares={use(handler:(req:any,res:any,next:(error?:unknown)=>void)=>void):unknown};
type DevServer={
  config:{root:string;logger:{info(message:string,options?:object):void}};
  middlewares:Middlewares;
  httpServer?:{once(event:'listening',listener:()=>void):unknown}|null;
  resolvedUrls?:{local:string[];network:string[]}|null;
};

/**
 * Serves the feedback inbox (SPEC.md) from the Vite dev server and `vite preview`, the server the headset
 * page already comes from, so the routes share its origin and its HTTPS. Not part of production builds.
 */
export function jxrvis(options:VitePluginOptions={}){
  const install=(server:DevServer)=>{
    const root=resolve(server.config.root,options.inbox??DEFAULT_INBOX);
    const log=options.log??((line:string)=>server.config.logger.info(`[jXRvis] ${line}`,{timestamp:true}));
    const token=options.token===false?false:options.token??pairingToken(root);
    // Vite checks the Host header itself (server.allowedHosts), so the inbox does not check it again.
    const handle=feedbackInbox({allowedHosts:true,...options,token,root,log});
    server.middlewares.use((req,res,next)=>{void handle(req,res,next).catch(next);});
    // On the network (--host), a headset pairs one time: it opens the page with the token.
    server.httpServer?.once('listening',()=>setTimeout(()=>{
      const network=server.resolvedUrls?.network??[];
      if(!network.length)return;
      if(token===false){log('no pairing token: anyone on the network can send takes to your agent');return;}
      log('to pair a headset, open this address on it one time:');
      for(const url of network)log(`  ${url}#jxrvis=${token}`);
    },200));
  };
  return {
    name:'jxrvis',
    configureServer:install,
    configurePreviewServer:install,
  };
}

export default jxrvis;
