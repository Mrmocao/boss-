import test from 'node:test';import assert from 'node:assert/strict';
import {buildOperations} from '../src/dashboard-metrics.mjs';
import {ingestSnapshot} from '../src/monitor-core.mjs';
test('statistics follow Shanghai midnight and never count unknown historical dates as today',()=>{
 const now=Date.parse('2026-11-12T00:30:00+08:00');
 const state={conversations:{a:{id:'a',admitted:true,admittedAt:'2026-11-11T16:05:00Z',messages:[{direction:'incoming',text:'你好'}]},b:{id:'b',admitted:true,admittedAt:'2026-11-11T15:55:00Z',workflow:{stage:'waiting_email'}},c:{id:'c',admitted:true,status:'human_review',human_handoff:true},d:{id:'d',admitted:true,workflow:{stage:'awaiting_review'}},e:{id:'e',admitted:false,admittedAt:'2026-11-11T16:05:00Z'}},sentIntents:{i:{conversationId:'a',status:'sent_confirmed',receipt:{observedAt:'2026-11-11T16:06:00Z'}}}};
 const op=buildOperations(state,{now});assert.equal(op.counts.todayNew,1);assert.equal(op.counts.yesterdayNew,1);assert.equal(op.counts.unknownStart,2);assert.equal(op.counts.communicating,3);assert.equal(op.counts.pendingReply,1);assert.equal(op.counts.humanReview,1);assert.equal(op.counts.awaitingReview,1);assert.equal(op.counts.todaySent,1);
 assert.notEqual(buildOperations(state,{platformId:'other',now}).conversations[0].key,op.conversations[0].key);
 assert.notEqual(buildOperations(state,{accountId:'other',now}).conversations[0].key,op.conversations[0].key);
});
test('first observed and first admitted timestamps survive repeated polling',()=>{
 const s={conversations:{},runtime:{},controls:{},events:[],notifications:[]},row={domRowId:'a',name:'甲',jobTitle:'数值策划',lastMessagePreview:'你好'};
 const config={acceptedTitles:['数值策划'],maxConversations:3};
 ingestSnapshot(s,{account:{displayName:'招聘'},rows:[row]},config,1000);assert.equal(s.conversations.a.firstObservedAt,new Date(1000).toISOString());assert.equal(s.conversations.a.admittedAt,undefined);
 ingestSnapshot(s,{account:{displayName:'招聘'},rows:[{...row,lastMessagePreview:'补充'}]},config,2000);
 ingestSnapshot(s,{account:{displayName:'招聘'},rows:[{...row,lastMessagePreview:'补充'}]},config,3000);
 assert.equal(s.conversations.a.admittedAt,new Date(2000).toISOString());assert.equal(s.conversations.a.firstObservedAt,new Date(1000).toISOString());
});
