import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runMonitor} from '../src/monitor-daemon.mjs';
import {MonitorStore} from '../src/monitor-store.mjs';
import {ingestSnapshot} from '../src/monitor-core.mjs';
import {loadWorkflowPolicy} from '../src/recruiting-workflow.mjs';
const policy=await loadWorkflowPolicy();
const row={id:'test',domRowId:'test',name:'测试',jobTitle:'数值策划'};
const messages=[{direction:'incoming',kind:'text',text:'我已本科毕业，想做游戏策划'}];
const snapshot=()=>({account:{displayName:'招聘员'},rows:[row],selectedRow:row,activity:{typing:false,lastHumanAt:0},detail:{account:{displayName:'招聘员'},selected:row,candidate:{educationText:['某大学 · 信息与计算科学 · 本科']},messages:structuredClone(messages)}});
const config={profile:'company-2',expectedAccountDisplayName:'招聘员',mode:'automatic',allowSend:true,allowAssessment:true,acceptedTitles:['数值策划'],maxConversations:100,tickMs:1,debounceMs:30000,reconcileMs:180000,rulesFile:'config/jobs/game-execution-planner.yaml',model:{enabled:true,source:'file',baseUrl:'https://fake.invalid/v1',name:'fake',apiKey:'fake'}};
for(const race of [false,true])test(`automatic daemon waits from restart and ${race?'discards a decision when a new message arrives':'executes only a fresh S1 plan'}`,async t=>{
 const root=await mkdtemp(join(tmpdir(),'automatic-daemon-'));t.after(()=>rm(root,{recursive:true,force:true}));
 let clock=100000;t.mock.method(Date,'now',()=>clock);
 const store=await new MonitorStore(root).init();await store.transaction(s=>{s.imports={singleConversationV1:'test'};s.conversations.test={...row,admitted:true};ingestSnapshot(s,snapshot(),config,1);});await store.close();
 let generated=false,sends=0,polls=0;
 const browser={target:{id:'mock'},async connect(){return snapshot();},async scanStep(){clock+=31000;return snapshot();},async poll(){clock+=31000;polls++;const s=snapshot();if(generated&&race){s.detail.messages.push({direction:'incoming',kind:'text',text:'还有一个薪资问题'});s.rows=[{...row,lastMessagePreview:'还有一个薪资问题'}];}
   if(generated&&race){await mkdir(join(root,'commands'),{recursive:true});const state=JSON.parse(await readFile(join(root,'state.json'),'utf8'));const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';await writeFile(join(root,'commands',id+'.json'),JSON.stringify({id,command:'stop',runId:state.runtime.runId,createdAt:new Date().toISOString()}));}return s;},async close(){},async openConversation(){throw Error('unexpected navigation');}};
 const analyzer=async()=>{generated=true;return {education:[{level:'本科',major:'信息与计算科学',stage:'graduated'}],intent:{value:'yes'},concern:{kind:'none'},consent:{value:'unknown'}};};
 const sender=async({store,plan})=>{sends++;assert.equal(plan.messageId,'S1');await store.transaction(s=>{s.controls.stopRequested=true;});};
 await runMonitor({root,config,browser,policy,analyzer,sender});
 assert.ok(generated);assert.equal(sends,race?0:1);assert.ok(polls>=1);
});
