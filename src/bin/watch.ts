#!/usr/bin/env node
// jXRvis watcher: prints one line per new take once it is ready, for any agent that can watch a command's
// output (Claude Code's Monitor, a terminal, a script). Takes already in the inbox are left alone.
//   jxrvis-watch [--inbox feedback/inbox] [--wait 60] [--every 2] [--include-existing] [--once]
import {resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {DEFAULT_INBOX} from '../spec.ts';
import {TakeTracker,describe} from '../agent/inbox.ts';

const {values,positionals}=parseArgs({allowPositionals:true,options:{
  inbox:{type:'string'},wait:{type:'string',default:'60'},every:{type:'string',default:'2'},
  'include-existing':{type:'boolean',default:false},once:{type:'boolean',default:false},help:{type:'boolean',short:'h'},
}});
if(values.help){
  console.log(`jxrvis-watch: one line per new headset take.

  --inbox <dir>         the inbox folder (default ${DEFAULT_INBOX}, or $JXRVIS_INBOX)
  --wait <s>            how long to wait for a transcript that has not come (default 60)
  --every <s>           how often to look (default 2)
  --include-existing    also report earlier takes that have no status yet
  --once                report what is ready now and exit

Each line: FEEDBACK <id> [<summary>]: <transcript>
       or: ANSWER <id> to <asking id> [<your question>]: <transcript>   (the player answering you)
The take's files are in <inbox>/<id>/ (view.png, voice.*, transcript.txt, context.json).
Answer the headset by writing status lines to <inbox>/<id>/status.txt (see AGENTS.md).`);
  process.exit(0);
}

const inbox=resolve(values.inbox??positionals[0]??process.env.JXRVIS_INBOX??DEFAULT_INBOX);
const tracker=new TakeTracker(inbox,{wait:Number(values.wait),includeExisting:values['include-existing']});
const report=()=>{for(const take of tracker.poll())console.log(describe(take));};

if(values.once){report();process.exit(0);}
console.log(`Watching ${inbox} (takes are folders here; status goes in <id>/status.txt)`);
report();
setInterval(report,Number(values.every)*1000);
