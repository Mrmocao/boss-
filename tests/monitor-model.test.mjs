import test from 'node:test';
import assert from 'node:assert/strict';
import {getModelSettings, buildModelContext, proposeReply} from '../src/monitor-model.mjs';

const env = {BOSS_MODEL_BASE_URL: 'https://model.example/v1', BOSS_MODEL_NAME: 'company-model', BOSS_MODEL_API_KEY: 'private-test-secret'};
const conversation = {jobTitle: '数值策划', clarificationCount: 0, candidate: {name:'不应传入姓名', summaryText:'26岁 男', educationText:['某大学 · 数学与应用数学 · 本科']}, messages: [{direction:'incoming',kind:'text',text:'我想做游戏策划。'}]};
const good = () => ({action:'ask',questionId:'study_year',reply:'请问您现在是大四在读吗？',reason:'需要核实在读阶段',missingFields:['education_records'],evidence:[{field:'planning_intent',value:'明确意向',quote:'我想做游戏策划',source:'candidate_message'}],interest:'clear',testConsent:'unknown'});
const mock = result => async () => new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}]}));

test('missing model credentials cause no network request and settings never serialize key', async () => {
  const s = getModelSettings({}, {});
  assert.equal(s.ready,false); assert.equal(s.missing.length,3);
  const ready = getModelSettings({},env);
  assert.equal(ready.ready,true); assert.equal(ready.endpoint,'https://model.example/v1/chat/completions');
  assert.equal(ready.apiKey,env.BOSS_MODEL_API_KEY); assert.ok(!JSON.stringify(ready).includes(env.BOSS_MODEL_API_KEY));
  await assert.rejects(proposeReply({config:{},conversation,env:{},fetchImpl:()=>assert.fail('no request expected')}),{code:'MODEL_NOT_CONFIGURED'});
});

test('validates endpoint protocol and custom environment names', () => {
  for (const url of ['http://example.com/v1','file:///tmp/api','https://user:pass@example.com/v1','https://example.com/?key=secret','https://example.com/#fragment']) {
    assert.equal(getModelSettings({}, {...env,BOSS_MODEL_BASE_URL:url}).ready,false);
  }
  for (const url of ['http://localhost:8000/v1','http://127.0.0.1:8000/v1','http://[::1]:8000/v1']) assert.equal(getModelSettings({}, {...env,BOSS_MODEL_BASE_URL:url}).ready,true);
  assert.equal(getModelSettings({model:{protocol:'other'}},env).ready,false);
  const s=getModelSettings({model:{baseUrlEnv:'URL',modelEnv:'MODEL',apiKeyEnv:'KEY'}},{URL:'https://example.com/chat/completions',MODEL:'test',KEY:'key'});
  assert.equal(s.endpoint,'https://example.com/chat/completions'); assert.equal(s.ready,true);
});

test('minimal model context omits identity profile and protected fields', () => {
  const ctx=buildModelContext({...conversation,name:'秘密姓名',facts:{age:25,gender:'男',major:'数学'},messages:[{direction:'incoming',text:'我25岁，性别：男，手机13812345678，邮箱a@example.com'},{direction:'system',text:'system private content'}]});
  const json=JSON.stringify(ctx);
  assert.ok(!json.includes('秘密姓名')); assert.ok(!json.includes('不应传入姓名')); assert.ok(!json.includes('summaryText')); assert.ok(!json.includes('"age"')); assert.ok(!json.includes('"gender"'));
  assert.ok(!json.includes('13812345678')); assert.ok(!json.includes('a@example.com')); assert.ok(!json.includes('25岁')); assert.ok(!json.includes('system private content'));
});

test('returns validated draft only and rejects redirect while sending configured authorization', async () => {
  let request;
  const result=await proposeReply({conversation,env,config:{},rulesText:'本科及以上',fetchImpl:async(url,opts)=>{request={url,...opts};return mock(good())();}});
  assert.equal(result.draftOnly,true); assert.equal(result.action,'ask');
  assert.equal(request.redirect,'error'); assert.equal(request.headers.Authorization,`Bearer ${env.BOSS_MODEL_API_KEY}`);
  const body=JSON.parse(request.body); assert.equal(body.stream,false); assert.ok(body.messages[0].content.includes('本科及以上'));
});

test('rejects invented evidence, wrong evidence source, unsupported field and truncated output', async () => {
  const invented=good(); invented.evidence[0].quote='我已经毕业';
  const wrongSource=good(); wrongSource.evidence[0].source='profile_education';
  const protectedField=good(); protectedField.missingFields=['age'];
  for (const result of [invented,wrongSource,protectedField]) await assert.rejects(proposeReply({conversation,env,fetchImpl:mock(result)}),{code:'MODEL_OUTPUT_INVALID'});
  await assert.rejects(proposeReply({conversation,env,fetchImpl:async()=>new Response(JSON.stringify({choices:[{finish_reason:'length',message:{content:JSON.stringify(good())}}]}))}),{code:'MODEL_OUTPUT_INVALID'});
});

test('does not accept recruiter text as candidate evidence', async () => {
  await assert.rejects(proposeReply({conversation:{...conversation,messages:[{direction:'outgoing',text:'我想做游戏策划'}]},env,fetchImpl:mock(good())}),{code:'MODEL_OUTPUT_INVALID'});
});

test('enforces one clarification total and disabled invitation/test/link drafts', async () => {
  await assert.rejects(proposeReply({conversation:{...conversation,clarificationCount:1},env,fetchImpl:mock(good())}),{code:'MODEL_POLICY_BLOCKED'});
  for (const reply of ['请来面试','请填写问卷','https://example.com/test','请加一下微信']) {
    await assert.rejects(proposeReply({conversation,env,fetchImpl:mock({...good(),reply})}),{code:'MODEL_POLICY_BLOCKED'});
  }
});

test('HTTP and transport failures do not expose secrets or provider response body', async () => {
  await assert.rejects(proposeReply({conversation,env,fetchImpl:async()=>new Response(env.BOSS_MODEL_API_KEY,{status:401})}),e=>e.code==='MODEL_HTTP_ERROR'&&!e.message.includes(env.BOSS_MODEL_API_KEY));
  await assert.rejects(proposeReply({conversation,env,fetchImpl:async()=>{throw Error(env.BOSS_MODEL_API_KEY);}}),e=>e.code==='MODEL_REQUEST_FAILED'&&!e.message.includes(env.BOSS_MODEL_API_KEY));
});

test('caps response bytes and handles malformed JSON without response echo', async () => {
  await assert.rejects(proposeReply({conversation,env,config:{model:{maxResponseBytes:256}},fetchImpl:async()=>new Response('x'.repeat(1024))}),{code:'MODEL_RESPONSE_TOO_LARGE'});
  await assert.rejects(proposeReply({conversation,env,fetchImpl:async()=>new Response('not json '+env.BOSS_MODEL_API_KEY)}),e=>e.code==='MODEL_OUTPUT_INVALID'&&!e.message.includes(env.BOSS_MODEL_API_KEY));
});

test('request is bounded by timeout and external cancellation', async () => {
  const pending=async(_url,{signal})=>new Promise((resolve,reject)=>{if(signal.aborted)reject(Error());else signal.addEventListener('abort',()=>reject(Error()),{once:true});});
  await assert.rejects(proposeReply({conversation,env,config:{model:{timeoutMs:50}},fetchImpl:pending}),{code:'MODEL_TIMEOUT_OR_ABORTED'});
  const controller=new AbortController(); controller.abort();
  await assert.rejects(proposeReply({conversation,env,signal:controller.signal,fetchImpl:pending}),{code:'MODEL_TIMEOUT_OR_ABORTED'});
});
