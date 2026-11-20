import test from 'node:test';import assert from 'node:assert/strict';
import {archiveInactiveConversations,RETENTION_MS} from '../src/conversation-retention.mjs';
import {ingestSnapshot} from '../src/monitor-core.mjs';
import {buildOperations} from '../src/dashboard-metrics.mjs';
const NOW=Date.parse('2026-11-13T16:00:00+08:00'),config={retentionDays:3,profile:'company-2',acceptedTitles:['数值策划'],maxConversations:100,mode:'automatic'};
const record=(id,at)=>({id,domRowId:id,name:'甲',jobTitle:'数值策划',admitted:true,lastLiveChangeAt:at,workflow:{stage:'waiting_consent'},messages:[{text:'old private text'}]});
const state=()=>({conversations:{},sentIntents:{},notifications:[],events:[],runtime:{},controls:{}});
test('three days strictly greater removes conversation contents and retains counts and dedup tombstone',()=>{
 const s=state();s.conversations.a=record('a',NOW-RETENTION_MS-1);s.conversations.b=record('b',NOW-RETENTION_MS);assert.equal(archiveInactiveConversations(s,config,NOW).archived,1);assert.ok(s.conversations.b);assert.equal(s.archivedConversations.a.name,undefined);assert.equal(s.archivedConversations.a.messages,undefined);
 ingestSnapshot(s,{account:{displayName:'招聘员'},rows:[{domRowId:'a',name:'甲',jobTitle:'数值策划',displayTime:'刚刚',lastMessagePreview:'新消息',unreadCount:5}]},config,NOW);assert.equal(s.conversations.a,undefined);
 const metrics=buildOperations(s,{now:NOW}).counts;assert.equal(metrics.archivedTotal,1);assert.equal(metrics.archivedInactive,1);assert.equal(metrics.total,1);
});
test('explicit rejection and declined questionnaire are removed, uncertain major is not rejection',()=>{
 const s=state();for(const [id,stage] of [['no','declined_test'],['fail','rejected_screening'],['human','screening']]){s.conversations[id]=record(id,NOW);s.conversations[id].workflow.stage=stage;}
 s.conversations.human.human_handoff=true;archiveInactiveConversations(s,config,NOW);assert.deepEqual(Object.keys(s.conversations),['human']);assert.equal(s.archivedConversations.no.reason,'declined');assert.equal(s.archivedConversations.fail.reason,'not_qualified');
});
test('read-only polling does not count as new interaction; unknown send stays visible',()=>{
 const s=state();s.conversations.old={...record('old',0),row:{displayTime:'11月01日'},lastObservedAt:new Date(NOW).toISOString()};s.conversations.unknown=record('unknown',NOW-RETENTION_MS-1);s.sentIntents.i={conversationId:'unknown',status:'send_unknown'};archiveInactiveConversations(s,config,NOW);assert.equal(s.conversations.old,undefined);assert.ok(s.conversations.unknown);
});
test('recent actual send renews inactivity window and restart does not duplicate archive count',()=>{
 const s=state();s.conversations.a=record('a',NOW-RETENTION_MS-1);s.conversations.a.lastOutbound={receipt:{observedAt:new Date(NOW-1000).toISOString()}};assert.equal(archiveInactiveConversations(s,config,NOW).archived,0);archiveInactiveConversations(s,config,NOW+RETENTION_MS);const copy=JSON.parse(JSON.stringify(s));assert.equal(archiveInactiveConversations(copy,config,NOW+RETENTION_MS).archived,0);assert.equal(Object.keys(copy.archivedConversations).length,1);
});
