#!/usr/bin/env node
// jXRvis: the feedback inbox as a server of its own (SPEC.md). See README "Standalone server".
import {networkInterfaces} from 'node:os';
import {parseArgs} from 'node:util';
import {DEFAULT_INBOX} from '../spec.ts';
import {createFeedbackServer} from '../server/standalone.ts';

const HELP=`jxrvis-server: the headset feedback inbox, with optional static files, over HTTP or HTTPS.

  --inbox <dir>        where takes are saved (default ${DEFAULT_INBOX})
  --static <dir>       also serve this folder (your built WebXR page)
  --port <n>           default 8443 with HTTPS, 8080 without
  --host <addr>        default 127.0.0.1; 0.0.0.0 to reach it from a headset on the LAN
  --cert <file>        PEM certificate, with --key, for HTTPS (the headset microphone needs it)
  --key <file>         PEM private key
  --transcribe <x>     none (default) or a transcription server URL,
                       e.g. http://127.0.0.1:8788/transcribe (tools/whisper-server.py)
  --speech <x>         none (default: the headset's own voice) or a text-to-speech server URL
                       that takes POST {"text"} and answers audio
  --base <path>        URL path of the routes (default /api/feedback)`;

const {values}=parseArgs({options:{
  inbox:{type:'string',default:DEFAULT_INBOX},static:{type:'string'},port:{type:'string'},host:{type:'string',default:'127.0.0.1'},
  cert:{type:'string'},key:{type:'string'},transcribe:{type:'string',default:'none'},speech:{type:'string',default:'none'},base:{type:'string'},help:{type:'boolean',short:'h'},
}});
if(values.help){console.log(HELP);process.exit(0);}

const secure=!!values.cert;
const server=createFeedbackServer({root:values.inbox,static:values.static,cert:values.cert,key:values.key,transcribe:values.transcribe,speech:values.speech,base:values.base,log:line=>console.log(line)});
const {port}=await server.listen(Number(values.port??(secure?8443:8080)),values.host);
const scheme=secure?'https':'http';
console.log(`Feedback inbox ${values.inbox} (transcriber: ${values.transcribe}, speech: ${values.speech})`);
console.log(`  ${scheme}://localhost:${port}/`);
if(values.host==='0.0.0.0')for(const list of Object.values(networkInterfaces()))for(const a of list??[])if(a.family==='IPv4'&&!a.internal)console.log(`  ${scheme}://${a.address}:${port}/`);
if(!secure&&values.host!=='127.0.0.1')console.log('  Plain HTTP: a headset gets the microphone only on http://localhost (adb reverse) or with --cert/--key.');
