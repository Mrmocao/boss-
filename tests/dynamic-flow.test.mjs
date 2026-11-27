import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {cleanFlow} from '../src/dynamic-flow.mjs';
import {saveJobProfiles,readJobProfiles,contextForJob} from '../src/job-settings.mjs';
import {loadWorkflowPolicy,planWorkflow,confirmWorkflowSend} from '../src/recruiting-workflow.mjs';
import {analyzeWorkflow} from '../src/workflow-model.mjs';

const rules=[
  {id:'intro',after:'',action:'reply',condition:'有排版项目经验',text:'请介绍一个排版作品。'},
  {id:'review',after:'intro',action:'handoff',condition:'已介绍具体作品',text:''}
];
const job={id:'layout',name:'排版',acceptedTitles:['排版'],status:'dynamic',flow:{fallback:'wait',rules},requirements:'',url:''};
const conversation=()=>({id:'test',messages:[{direction:'incoming',text:'我做过排版项目。'}]});
const settings={model:{enabled:true,source:'file',apiKey:'test',name:'test',baseUrl:'https://example.com'}};
const reply=(id,quote='排版项目')=>async()=>Response.json({choices:[{message:{content:JSON.stringify({matches:[{id,source:'candidate_message',quote}],review:false})}}]});

test('dynamic job saves, matches by title and unlocks its next rule only after a confirmed delivery',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'dynamic-job-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const path=join(dir,'jobs.json');
  const initial=await readJobProfiles(path);
  await saveJobProfiles(path,{revision:initial.revision,job});
  const {config,policy}=contextForJob({...settings,jobProfiles:await readJobProfiles(path)},await loadWorkflowPolicy(),job.name);
  const c=conversation(),analyze=fetchImpl=>analyzeWorkflow({config,policy,conversation:c,fetchImpl});
  await assert.rejects(analyze(reply('review')),{code:'MODEL_ANALYSIS_INVALID'});
  await assert.rejects(analyze(reply('intro','没有这个证据')),{code:'MODEL_ANALYSIS_INVALID'});
  const a=await analyze(reply('intro'));
  const plan=planWorkflow(c,a,policy,config);
  assert.equal(plan.text,rules[0].text);
  assert.equal(plan.messageId,'FLOW_REPLY');
  confirmWorkflowSend({conversations:{test:c}},c.id,plan,'receipt1');
  assert.equal(planWorkflow(c,a,policy,config).type,'wait');
  c.messages.push({direction:'incoming',text:'我设计过画册。'});
  assert.equal(planWorkflow(c,await analyze(reply('review','我设计过画册')),policy,config).type,'handoff');
});

test('rule ordering, fallback, syntax and questionnaire entry',async()=>{
  const policy={...await loadWorkflowPolicy(),job:{...job,flow:{fallback:'handoff',rules:[
    {...rules[0],id:'first',action:'questionnaire'},rules[0]
  ]}}};
  const plan=matches=>planWorkflow(conversation(),{concern:{kind:'none'},matches},policy,{});
  assert.equal(plan([{id:'intro'},{id:'first'}]).messageId,'S1');
  assert.equal(plan([]).type,'handoff');
  assert.throws(()=>cleanFlow({...job.flow,rules:[rules[1],rules[0]]}));
  assert.throws(()=>cleanFlow({...job.flow,rules:[rules[0],rules[0]]}));
});
