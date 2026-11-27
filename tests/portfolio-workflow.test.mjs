import {planWorkflow,confirmWorkflowSend} from '../src/recruiting-workflow.mjs';
import {saveJobProfiles,readJobProfiles} from '../src/job-settings.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {portfolioTemplates,screenPortfolio,validateFacts,portfolioSources,greetingFacts} from '../src/portfolio-workflow.mjs';
import {listPortfolioCases,updatePortfolioCase} from '../src/portfolio-cases.mjs';

const job=JSON.parse(await readFile(new URL('../config/concept-art-intern.json',import.meta.url)));
const val=value=>({value,quote:value,source:'chat'});
const qualified={level:val('本科'),year:val('2027'),enrollment:val('在读'),major:val('动画')};

test('art v4 uses complete major names, exclusively hard criteria and distinct refusal reasons',()=>{
  const step=changes=>screenPortfolio(job,{...qualified,...changes},false).step;
  assert.equal(step({}),'S2');
  for(const major of job.majors) assert.equal(step({major:val(major)}),'S2');
  assert.equal(step({major:val('动画制作技术')}),'S7');
  assert.equal(step({major:val('机械工程'),majorType:{value:'非对口',quote:'专业机械工程'}}),'S4');
  assert.equal(step({concern:val('培训期间会考核吗')}),'S7');
  for(const grade of job.blockedGrades) assert.equal(step({grade:val(grade)}),'S3');
  assert.equal(step({year:val('2026')}),'S3');
  assert.equal(step({enrollment:val('已毕业')}),'S3');
  assert.equal(step({level:val('高中')}),'S3');
  assert.equal(step({level:undefined}),'S5');
  assert.equal(step({year:undefined}),'S5');
  assert.equal(step({major:undefined}),'S5');
  assert.equal(step({intent:val('对游戏还不熟悉')}),'S2');
  assert.throws(()=>portfolioTemplates('S2'));
  assert.match(portfolioTemplates(job.prompt).S2,/zhaopin@youkia\.com/);
  assert.doesNotMatch(portfolioTemplates(job.prompt).S2,/后续状态|问卷/);
});

test('facts must cite the supplied source and preserve the raw major',()=>{
  const raw=Object.fromEntries(['level','grade','year','major','enrollment','majorType','concern','experience','intent','attachment','soft'].map(k=>[k,null]));
  raw.major=val('动画');
  assert.deepEqual(validateFacts(raw,{chat:'专业动画'}).major,raw.major);
  assert.throws(()=>validateFacts(raw,{profile:'专业动画'}));
  assert.throws(()=>validateFacts({...raw,major:{...raw.major,value:'插画'}},{chat:'专业动画'}));
});

async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'art-v4-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  let row=await updatePortfolioCase(root,job,{action:'create',name:'测试',reference:'a',account:'test'});
  const change=async(action,extra={},facts={})=>{
    row=await updatePortfolioCase(root,job,{action,id:row.id,revision:row.revision,...extra},async()=>facts);
    return row;
  };
  return {root,change,get row(){return row;}};
}

test('one confirmed clarification, later evidence, S6 and manual receipt through closure survive reload',async t=>{
  const f=await fixture(t);
  const analyze=facts=>f.change('analyze',{sources:{chat:'示例'}},facts);
  assert.equal((await analyze({})).pending.step,'S5');
  assert.equal(f.row.asked,false);
  await f.change('sent',{step:'S5'});
  assert.equal((await analyze({})).stage,'已追问');
  assert.equal(f.row.pending,null);
  assert.equal((await analyze(qualified)).pending.step,'S2');
  const old=f.row;
  await f.change('attachment');
  assert.equal(f.row.pending.step,'S6');
  await f.change('sent',{step:'S6'});
  assert.equal(f.row.pending.step,'S2');
  await assert.rejects(updatePortfolioCase(f.root,job,{action:'sent',id:old.id,revision:old.revision,step:'S2'}),{code:'PORTFOLIO_STATE_CHANGED'});
  await f.change('sent',{step:'S2'});
  await assert.rejects(f.change('receipt',{resume:true,portfolio:false}));
  assert.equal((await f.change('receipt',{resume:true,portfolio:true})).stage,'待批改');
  assert.deepEqual((await listPortfolioCases(f.root,job.id))[0],JSON.parse(JSON.stringify(f.row)));
  assert.equal((await f.change('review')).stage,'已批改');
  assert.equal((await f.change('close')).stage,'关闭');
});

test('S7 preempts attachment, manual resolution and terminal attachment handling',async t=>{
  const f=await fixture(t);
  await f.change('analyze',{sources:{chat:'培训'}},{attachment:val('附件'),concern:val('培训')});
  assert.equal(f.row.stage,'转人工');
  assert.equal(f.row.pending,null);
  await f.change('resolve',{step:'S4',reason:'已人工核对专业'});
  await f.change('sent',{step:'S4'});
  await f.change('attachment');
  assert.equal(f.row.stage,'婉拒-专业');
  assert.equal(f.row.pending,null);
});

test('portfolio title binding can be enabled and disabled; BOSS uses only the portfolio workflow',async t=>{
  const root=await mkdtemp(join(tmpdir(),'portfolio-binding-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const path=join(root,'jobs.json'),title='角色原画师（可接受实习生）';
  const {revision}=await readJobProfiles(path);
  const automatic={...job,delivery:'automatic',acceptedTitles:[title]};
  const saved=await saveJobProfiles(path,{revision,job:automatic});
  const policy={job:saved.jobs.find(j=>j.id===job.id)};
  const c={id:'art',jobTitle:title,messages:[{direction:'incoming',text:'你好，我找原画实习'}]};
  const plan=facts=>planWorkflow(c,{portfolioFacts:facts,concern:{kind:'none'}},policy,{});
  const ask=plan({});
  assert.equal(ask.messageId,'S6');
  confirmWorkflowSend({conversations:{art:c}},'art',ask,'ask');
  assert.equal(plan({}).type,'wait');
  assert.equal(plan({...qualified,major:val('艺术与科技')}).type,'handoff');
  assert.equal(plan({...qualified,year:val('2026')}).nextStage,'rejected_screening');
  const invite=plan(qualified);
  assert.match(invite.text,/zhaopin@youkia\.com/);
  assert.equal(invite.messageId,'PORTFOLIO_INVITE');
  confirmWorkflowSend({conversations:{art:c}},'art',invite,'invite');
  assert.equal(plan(qualified).type,'wait');
  const manual=await saveJobProfiles(path,{revision:saved.revision,job:{...automatic,delivery:'manual',acceptedTitles:[]}});
  assert.deepEqual(manual.jobs.find(j=>j.id===job.id).acceptedTitles,[]);
});

test('BOSS badge, education period and matching graduation statement support the pass decision',()=>{
 const profile={summaryText:'27年应届生',profileText:'2023-2027'};
 const context={education:['美术学院 · 动画 · 本科'],messages:[{direction:'incoming',text:'Boss您好，我是27年毕业生，可以和您进一步沟通原画这个职位吗？'}]};
 const sources=portfolioSources(profile,context);
 assert.equal(screenPortfolio(job,greetingFacts(sources,'原画',new Date('2026-11-27')),false).step,'S2');
 assert.equal(greetingFacts({...sources,chat:sources.chat.replace('27年','26年')},'原画'),null);
 assert.equal(greetingFacts({...sources,profile:sources.profile.replace('2023-2027','2023-2026')},'原画'),null);
 assert.equal(greetingFacts({...sources,chat:sources.chat+'请问薪资？'},'原画'),null);
});

test('missing portfolio facts create one clarification instead of an exception handoff',()=>{
 const policy={job:{...job,delivery:'automatic'},messages:{}};
 const c={id:'missing',jobTitle:'角色原画师（可接受实习生）',messages:[{direction:'incoming',text:'我对这个岗位感兴趣'}],workflow:{stage:'screening'}};
 const plan=planWorkflow(c,{portfolioFacts:{level:{value:'本科'},major:{value:'动画'}},concern:{kind:'none'}},policy,{});
 assert.equal(plan.messageId,'S6');
});

test('qualified inquiry gets the invite; only a verified pending card triggers rejection',()=>{
 const policy={job:{...job,delivery:'automatic'},messages:{}};
 const c={id:'attachment',jobTitle:'角色原画师（可接受实习生）',messages:[{direction:'incoming',text:'可以把简历发给您吗？'}],workflow:{stage:'screening'}};
 const plan=planWorkflow(c,{portfolioFacts:{level:{value:'本科'},year:{value:'2027'},enrollment:{value:'在读'},major:{value:'动画'},attachment:{value:'附件请求'}},concern:{kind:'none'}},policy,{});
 assert.equal(plan.messageId,'PORTFOLIO_INVITE');
 c.detail={attachmentRequests:[{status:'pending'}]};
 assert.equal(planWorkflow(c,{portfolioFacts:{},concern:{kind:'none'}},policy,{}).type,'reject_attachment');
});
