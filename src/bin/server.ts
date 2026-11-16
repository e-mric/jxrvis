#!/usr/bin/env node
// jXRvis: the feedback inbox as a server of its own (SPEC.md). See docs/guide.md "Standalone server".
import {networkInterfaces} from 'node:os';
import {parseArgs} from 'node:util';
import {DEFAULT_INBOX} from '../spec.ts';
import {pairingToken} from '../server/inbox.ts';
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
  --base <path>        URL path of the routes (default /api/feedback)
  --token <x>          the pairing token a headset on the network must send (default: a random one,
                       kept in <inbox>/.token); none: no token, anyone on the network can send takes
  --trust <ips>        comma-separated client IPs that need no token, e.g. your headset's
  --allowed-host <n>   comma-separated host names the page may be opened with, besides IPs and
                       localhost (e.g. my-pc.local; .example.test for a domain and its subdomains)`;

const {values}=parseArgs({options:{
  inbox:{type:'string',default:DEFAULT_INBOX},static:{type:'string'},port:{type:'string'},host:{type:'string',default:'127.0.0.1'},
  cert:{type:'string'},key:{type:'string'},transcribe:{type:'string',default:'none'},speech:{type:'string',default:'none'},base:{type:'string'},help:{type:'boolean',short:'h'},
  token:{type:'string'},trust:{type:'string'},'allowed-host':{type:'string'},
}});
if(values.help){console.log(HELP);process.exit(0);}

const secure=!!values.cert;
const list=(value:string|undefined)=>(value??'').split(',').map(v=>v.trim()).filter(Boolean);
const token=values.token==='none'?false:values.token??pairingToken(values.inbox);
const server=createFeedbackServer({root:values.inbox,static:values.static,cert:values.cert,key:values.key,transcribe:values.transcribe,speech:values.speech,base:values.base,
  token,trust:list(values.trust),allowedHosts:list(values['allowed-host']),log:line=>console.log(line)});
const {port}=await server.listen(Number(values.port??(secure?8443:8080)),values.host);
const scheme=secure?'https':'http';
console.log(`Feedback inbox ${values.inbox} (transcriber: ${values.transcribe}, speech: ${values.speech})`);
console.log(`  ${scheme}://localhost:${port}/`);
if(values.host!=='127.0.0.1'&&values.host!=='localhost'&&values.host!=='::1'){
  const addresses=values.host==='0.0.0.0'?Object.values(networkInterfaces()).flat().filter(a=>a?.family==='IPv4'&&!a.internal).map(a=>a!.address):[values.host];
  if(token===false)console.log('  No pairing token: anyone on the network can send takes to your agent.');
  else{
    console.log('  To pair a headset, open this address on it one time:');
    for(const address of addresses)console.log(`  ${scheme}://${address}:${port}/#jxrvis=${token}`);
  }
}
if(!secure&&values.host!=='127.0.0.1')console.log('  Plain HTTP: a headset gets the microphone only on http://localhost (adb reverse) or with --cert/--key.');
