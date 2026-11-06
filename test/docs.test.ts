import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {STATUS_PREFIXES} from '../src/spec.ts';

const read=(path:string)=>readFileSync(join(import.meta.dirname,'..',path),'utf8').replace(/\r\n/g,'\n');

test('the skill carries exactly the AGENTS.md snippet, under its frontmatter',()=>{
  const skill=read('agents/skills/jxrvis/SKILL.md');
  const [,frontmatter,body]=skill.match(/^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/)??[];
  assert.match(frontmatter??'',/^name: jxrvis$/m);
  assert.match(frontmatter??'',/^description: .+/m);
  assert.equal(body,read('agents/snippet.md'));
});

test('the spec and the agent rules name the same four status prefixes as the code',()=>{
  const spec=read('SPEC.md'),snippet=read('agents/snippet.md');
  for(const prefix of STATUS_PREFIXES){
    assert.ok(spec.includes(`\`${prefix}: …\``),`SPEC.md lists ${prefix}`);
    assert.ok(snippet.includes(`\`${prefix}`),`the snippet uses ${prefix}`);
  }
});
