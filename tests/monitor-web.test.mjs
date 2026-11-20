import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDashboardPayload } from '../src/monitor-web.mjs';

test('dashboard exposes admitted workflow state and keeps external actions explicit', () => {
  const payload=buildDashboardPayload({account:{displayName:'汪女士'},conversations:{c1:{id:'c1',admitted:true,name:'候选人',jobTitle:'数值策划',status:'waiting_reply',messages:[{direction:'incoming',text:'愿意了解'}],draft:'S1 草稿'}},notifications:[{type:'draft_ready',conversationId:'c1',at:'2026-11-09T00:00:00Z'}],sentIntents:{i1:{id:'i1',conversationId:'c1',status:'sent_confirmed',workflowStage:'s1_consent'}}},{running:true,responsive:true,runtime:{health:'observing'}});
  assert.equal(payload.conversations.length,1);assert.equal(payload.conversations[0].draft,'S1 草稿');assert.equal(payload.sentIntents[0].workflowStage,'s1_consent');assert.equal(payload.mailbox.status,'awaiting_configuration');assert.equal(payload.assessment.status,'link_required');
});

test('dashboard excludes non-admitted baseline rows', () => {
  const payload=buildDashboardPayload({conversations:{old:{id:'old',admitted:false,name:'历史候选人'}},notifications:[],sentIntents:{}},{running:false});
  assert.equal(payload.conversations.length,0);
});
