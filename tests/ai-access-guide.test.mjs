import test from 'node:test';
import assert from 'node:assert/strict';
import {buildAiAccessGuide} from '../src/ai-access-guide.mjs';
import {startMonitorWeb} from '../src/monitor-web.mjs';
test('AI onboarding is a static credential-free guide with correct routes and read-only limits',()=>{
 const guide=buildAiAccessGuide();assert.equal(guide.localBaseUrl,'http://127.0.0.1:19338');
 assert.ok(guide.localCredentialPath.endsWith('/.local/automation-api.json'));
 for(const field of ['{{BASE_URL}}','{{CREDENTIAL_PATH}}','freshness.stale','lastObservationAt','SNAPSHOT_CHANGED','只查询一次','正常则静默','钉钉','发送人工回复','sent_confirmed'])assert.ok(guide.instructions.includes(field),field);
 assert.ok(guide.instructions.includes('不得发送候选人消息'));
 assert.equal(guide.token,undefined);assert.equal(guide.routes.length,7);
});
test('dashboard serves AI guide only locally and contains direct-link navigation, no credential endpoint',async t=>{
 const server=await startMonitorWeb({port:0});t.after(()=>new Promise(r=>server.close(r)));const base=`http://127.0.0.1:${server.address().port}`;
 const r=await fetch(base+'/api/ai-guide');assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');assert.deepEqual(await r.json(),buildAiAccessGuide());
 assert.equal((await fetch(base+'/api/ai-guide',{headers:{Origin:'https://other.example'}})).status,403);
 const html=await(await fetch(base)).text();assert.ok(html.includes('data-page="ai-access"'));assert.ok(html.includes('id="copy-ai-prompt"'));assert.ok(html.includes('id="ai-prompt"'));
 assert.equal((await fetch(base+'/automation-api.json')).status,404);
});
