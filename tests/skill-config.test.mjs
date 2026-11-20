import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readMonitorConfig } from '../src/monitor-daemon.mjs';
import { getModelSettings, proposeReply } from '../src/monitor-model.mjs';

async function fixture(t, overrides={}) {
  const root=await mkdtemp(join(tmpdir(),'boss-skill-config-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const file=join(root,'config.json');
  const monitor=JSON.parse(await readFile(new URL('../config/monitor.json',import.meta.url),'utf8'));
  monitor.mode='observe_and_draft';monitor.allowSend=false;monitor.allowAssessment=false;monitor.debounceMs=5000;monitor.maxConversations=3;
  monitor.model={configFile:file};
  const monitorFile=join(root,'monitor.json');
  await writeFile(monitorFile,JSON.stringify(monitor));
  const doc={model:{enabled:true,protocol:'openai-compatible',baseUrl:'https://company.example/v1',name:'file-model',apiKey:'local-file-secret',...overrides},assessment:{filePath:join(root,'试题.xlsx')}};
  await writeFile(file,'\uFEFF'+JSON.stringify(doc));
  return {file,monitorFile,doc};
}

test('file config supplies real request settings without environment variables and never serializes key',async t=>{
  const {monitorFile,doc}=await fixture(t);
  const config=await readMonitorConfig(monitorFile);
  const settings=getModelSettings(config,{});
  assert.equal(settings.ready,true);
  assert.equal(config.assessment.filePath,doc.assessment.filePath);
  assert.equal(config.allowSend,false);
  assert.ok(!JSON.stringify(config).includes(doc.model.apiKey));
  assert.ok(!JSON.stringify(settings).includes(doc.model.apiKey));
  const proposal={action:'wait',questionId:null,reply:'',reason:'等待对方回复',missingFields:[],evidence:[],interest:'unknown',testConsent:'unknown'};
  const result=await proposeReply({config,env:{},conversation:{messages:[]},fetchImpl:async(url,options)=>{
    assert.equal(url,'https://company.example/v1/chat/completions');
    assert.equal(options.headers.Authorization,'Bearer local-file-secret');
    assert.equal(JSON.parse(options.body).model,'file-model');
    return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(proposal)}}]}));
  }});
  assert.equal(result.draftOnly,true);
});

test('empty file fields never silently fall back to old environment credentials or make requests',async t=>{
  const {monitorFile}=await fixture(t,{baseUrl:'',name:'',apiKey:''});
  const config=await readMonitorConfig(monitorFile);
  const env={BOSS_MODEL_BASE_URL:'https://wrong.example/v1',BOSS_MODEL_NAME:'wrong',BOSS_MODEL_API_KEY:'wrong-key'};
  const settings=getModelSettings(config,env);
  assert.equal(settings.ready,false);
  assert.deepEqual(settings.missing,['model.baseUrl','model.name','model.apiKey']);
  await assert.rejects(proposeReply({config,env,conversation:{},fetchImpl:()=>assert.fail('No request allowed')}),{code:'MODEL_NOT_CONFIGURED'});
});

test('reloading config picks up edited model and assessment path but ignores permission switches',async t=>{
  const {file,monitorFile,doc}=await fixture(t);
  const before=await readMonitorConfig(monitorFile);
  doc.model.name='new-model'; doc.model.apiKey='new-file-key'; doc.model.enabled=false;
  doc.assessment.filePath=join(tmpdir(),'另一份试题.xlsx');
  doc.allowSend=true; doc.allowAssessment=true; doc.profile='personal';
  await writeFile(file,JSON.stringify(doc));
  const after=await readMonitorConfig(monitorFile);
  assert.equal(before.model.name,'file-model');
  assert.equal(after.model.name,'new-model');
  assert.equal(after.model.apiKey,'new-file-key');
  assert.equal(after.model.enabled,false);
  assert.equal(after.assessment.filePath,doc.assessment.filePath);
  assert.equal(after.allowSend,false);assert.equal(after.allowAssessment,false);assert.equal(after.profile,before.profile);
});

test('invalid or missing file fails with a sanitized error, including malformed JSON containing a key',async t=>{
  const {file,monitorFile}=await fixture(t);
  for(const text of ['{"model":{"apiKey":"never-echo-this-secret"',JSON.stringify({model:{enabled:'true',apiKey:'never-echo-this-secret'}})]) {
    await writeFile(file,text);
    await assert.rejects(readMonitorConfig(monitorFile),e=>e.code==='SKILL_CONFIG_INVALID'&&!String(e).includes('never-echo-this-secret'));
  }
  await rm(file);
  await assert.rejects(readMonitorConfig(monitorFile),{code:'SKILL_CONFIG_UNAVAILABLE'});
});

test('invalid endpoint remains rejected in file mode and a full chat endpoint is accepted',async t=>{
  const {file,monitorFile,doc}=await fixture(t,{baseUrl:'https://user:password@example.com/v1'});
  assert.equal(getModelSettings(await readMonitorConfig(monitorFile),{}).invalid,'INVALID_BASE_URL');
  doc.model.baseUrl='https://company.example/api/chat/completions';
  await writeFile(file,JSON.stringify(doc));
  assert.equal(getModelSettings(await readMonitorConfig(monitorFile),{}).endpoint,doc.model.baseUrl);
});

test('private HTTP requires explicit file opt-in and never permits public or link-local HTTP',async t=>{
  const {file,monitorFile,doc}=await fixture(t,{baseUrl:'http://192.168.5.249:8080/v1'});
  assert.equal(getModelSettings(await readMonitorConfig(monitorFile),{}).ready,false);
  doc.model.allowPrivateHttp=true;
  for(const host of ['192.168.5.249','10.0.0.1','172.16.0.1','172.31.255.254']) {
    doc.model.baseUrl=`http://${host}:8080/v1`;await writeFile(file,JSON.stringify(doc));
    assert.equal(getModelSettings(await readMonitorConfig(monitorFile),{}).ready,true);
  }
  for(const host of ['8.8.8.8','169.254.169.254','172.32.0.1','company.example']) {
    doc.model.baseUrl=`http://${host}:8080/v1`;await writeFile(file,JSON.stringify(doc));
    assert.equal(getModelSettings(await readMonitorConfig(monitorFile),{}).ready,false);
  }
  doc.model.allowPrivateHttp='true';await writeFile(file,JSON.stringify(doc));
  await assert.rejects(readMonitorConfig(monitorFile),{code:'SKILL_CONFIG_INVALID'});
});
