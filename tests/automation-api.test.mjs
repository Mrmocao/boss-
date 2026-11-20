import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,mkdir} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createServer} from 'node:net';
import {startAutomationApi,buildAutomationSnapshot,loadAutomationState} from '../src/automation-api.mjs';
const NOW=Date.parse('2026-11-16T10:00:00+08:00'),TOKEN='A'.repeat(43);
function loaded(){return {state:{account:{displayName:'private-name'},runtime:{profile:'company-2',mode:'automatic',health:'observing',heartbeatAt:new Date(NOW).toISOString(),lastObservationAt:new Date(NOW).toISOString(),sendEnabled:true,modelReady:true,capabilities:{assessmentDelivery:'link',assessmentLinkReady:true,assessmentExpiresAt:'2026-11-14T02:35:44Z'},mailbox:{status:'connected',checkedAt:'2026-11-15T00:00:00Z',accounts:[{id:'secret@example.com',status:'connected',password:'secret-pass'}]}},controls:{},conversations:{a:{id:'a',admitted:true,name:'private-name',jobTitle:'private-job',human_handoff:true,handoffReason:'secret-pass is in free text',messages:[{text:'private-message',direction:'incoming'}],draft:'private-draft',workflow:{stage:'screening'},handoff:{openedAt:'2026-11-16T01:00:00Z'}},b:{id:'b',admitted:true,status:'waiting_reply'}},sentIntents:{i:{conversationId:'a',status:'sent_confirmed',text:'https://private?Signature=secret'}},notifications:[{reason:'private-note'}]},monitor:{running:true,responsive:true,heartbeatAt:new Date(NOW).toISOString(),heartbeatAgeMs:0},supervisor:{running:true,responsive:true,heartbeatAt:new Date(NOW).toISOString(),heartbeatAgeMs:0}};}
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'automation-api-'));const configPath=join(root,'api.json');
 const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 const config={enabled:true,host:'127.0.0.1',port,token:TOKEN};await writeFile(configPath,JSON.stringify(config));
 const value=loaded();let now=NOW;const server=await startAutomationApi({configPath,loadState:async()=>structuredClone(value),now:()=>now});
 t.after(async()=>{await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});});
 return {value,config,configPath,root,base:`http://127.0.0.1:${port}`,headers:{Authorization:`Bearer ${TOKEN}`},tick(ms){now+=ms;}};
}
test('snapshot excludes secrets, candidate text and signed URLs while reporting integration freshness',()=>{
 const s=buildAutomationSnapshot(loaded(),NOW),raw=JSON.stringify(s);
 for(const secret of ['private-name','private-job','private-message','private-draft','private-note','secret-pass','secret@example.com','Signature'])assert.ok(!raw.includes(secret),secret);
 assert.equal(s.integrations.platforms[0].accounts[0].connected,true);assert.equal(s.integrations.assessment.status,'link_expired');assert.equal(s.integrations.mailbox.stale,true);assert.equal(s.humanIntervention.total,1);
 const stale=loaded();stale.monitor.responsive=false;const offline=buildAutomationSnapshot(stale,NOW);assert.equal(offline.service.automaticProcessingActive,false);assert.equal(offline.integrations.platforms[0].accounts[0].connected,false);
 const restarted=loaded();restarted.monitor.startedAt=new Date(NOW+1).toISOString();assert.equal(buildAutomationSnapshot(restarted,NOW+2).service.observationFresh,false);
});
test('bearer auth required on every endpoint, no query tokens or mutation/browser routes',async t=>{
 const f=await fixture(t);
 for(const route of ['/api/v1/snapshot','/api/v1/health','/api/v1/openapi.json','/api/command'])assert.equal((await fetch(f.base+route)).status,401);
 assert.equal((await fetch(f.base+'/api/v1/snapshot?token='+TOKEN)).status,401);
 assert.equal((await fetch(f.base+'/api/v1/snapshot',{headers:{Authorization:'Bearer wrong'}})).status,401);
 assert.equal((await fetch(f.base+'/api/v1/snapshot',{headers:{...f.headers,Origin:'https://evil.test'}})).status,403);
 assert.equal((await fetch(f.base+'/api/v1/snapshot',{method:'POST',headers:f.headers})).status,405);
 assert.equal((await fetch(f.base+'/api/command',{headers:f.headers})).status,404);
 assert.equal((await fetch(f.base+'/api/settings',{headers:f.headers})).status,404);
 assert.equal((await fetch(f.base+'/api/v1/snapshot',{headers:f.headers})).status,200);
});
test('token rotation and disabled switch apply without restart',async t=>{
 const f=await fixture(t);await writeFile(f.configPath,JSON.stringify({...f.config,token:'B'.repeat(43)}));
 assert.equal((await fetch(f.base+'/api/v1/snapshot',{headers:f.headers})).status,401);
 assert.equal((await fetch(f.base+'/api/v1/snapshot',{headers:{Authorization:'Bearer '+'B'.repeat(43)}})).status,200);
 await writeFile(f.configPath,JSON.stringify({...f.config,enabled:false}));assert.equal((await fetch(f.base+'/api/v1/snapshot',{headers:f.headers})).status,503);
});
test('pagination and snapshot changes are explicit, metadata is versioned',async t=>{
 const f=await fixture(t);const first=await(await fetch(f.base+'/api/v1/conversations?limit=1',{headers:f.headers})).json();assert.equal(first.apiVersion,'v1');assert.equal(first.data.items.length,1);assert.ok(first.data.nextCursor);
 const next=await(await fetch(f.base+'/api/v1/conversations?limit=1&cursor='+encodeURIComponent(first.data.nextCursor),{headers:f.headers})).json();assert.equal(next.data.items.length,1);assert.notEqual(next.data.items[0].conversationRef,first.data.items[0].conversationRef);assert.equal(next.data.nextCursor,null);
 f.value.state.conversations.b.status='human_review';assert.equal((await fetch(f.base+'/api/v1/conversations?cursor='+encodeURIComponent(first.data.nextCursor),{headers:f.headers})).status,409);
 assert.equal((await fetch(f.base+'/api/v1/conversations?limit=100000',{headers:f.headers})).status,400);
 assert.equal((await fetch(f.base+'/api/v1/conversations?cursor=garbage',{headers:f.headers})).status,400);
});
test('ETag supports unchanged polling and stale observations never become healthy on read',async t=>{
 const f=await fixture(t);const first=await fetch(f.base+'/api/v1/snapshot',{headers:f.headers});const tag=first.headers.get('etag');assert.ok(tag);assert.equal((await fetch(f.base+'/api/v1/snapshot',{headers:{...f.headers,'If-None-Match':tag}})).status,304);
 f.tick(120000);const next=await(await fetch(f.base+'/api/v1/snapshot',{headers:{...f.headers,'If-None-Match':tag}})).json();assert.equal(next.freshness.stale,true);assert.equal(next.data.service.automaticProcessingActive,false);
});
test('missing state reports unavailable; malformed state is rejected; process liveness uses lock and heartbeat',async t=>{
 const f=await fixture(t);const monitorRoot=join(f.root,'monitor'),serviceRoot=join(f.root,'service');
 const absent=await loadAutomationState({monitorRoot,serviceRoot,now:NOW});assert.equal(absent.monitor.running,false);
 await mkdir(join(monitorRoot,'daemon.lock'),{recursive:true});await writeFile(join(monitorRoot,'daemon.lock/owner.json'),JSON.stringify({pid:process.pid}));
 await writeFile(join(monitorRoot,'state.json'),JSON.stringify({runtime:{pid:process.pid,heartbeatAt:new Date(NOW-100000).toISOString()},conversations:{}}));const stale=await loadAutomationState({monitorRoot,serviceRoot,now:NOW});assert.equal(stale.monitor.running,true);assert.equal(stale.monitor.responsive,false);
 await writeFile(join(monitorRoot,'state.json'),'{malformed');await assert.rejects(loadAutomationState({monitorRoot,serviceRoot}));
});

test('OpenAPI references resolve and documented GET routes work with authentication',async t=>{
 const f=await fixture(t);const descriptor=await(await fetch(f.base+'/api/v1/openapi.json',{headers:f.headers})).json();assert.equal(descriptor.openapi,'3.1.0');
 const walk=value=>{if(!value||typeof value!=='object')return;if(value.$ref){const parts=value.$ref.slice(2).split('/');let target=descriptor;for(const part of parts)target=target?.[part];assert.ok(target,value.$ref);}for(const v of Object.values(value))walk(v);};walk(descriptor);
 for(const path of Object.keys(descriptor.paths))assert.equal((await fetch(f.base+path,{headers:f.headers})).status,200,path);
});
test('bounded polling reports rate limit and resumes after the window',async t=>{
 const f=await fixture(t);for(let i=0;i<120;i++)assert.equal((await fetch(f.base+'/api/v1/health',{headers:f.headers})).status,200);
 const limited=await fetch(f.base+'/api/v1/health',{headers:f.headers});assert.equal(limited.status,429);assert.equal(limited.headers.get('retry-after'),'60');
 f.tick(60001);assert.equal((await fetch(f.base+'/api/v1/health',{headers:f.headers})).status,200);
});
