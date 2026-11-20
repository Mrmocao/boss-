import test from 'node:test';import assert from 'node:assert/strict';
import {activityWindow,isRecentRow,shouldInspectConversation} from '../src/recent-conversations.mjs';
import {ingestSnapshot} from '../src/monitor-core.mjs';
import {sameListContext,contextKey} from '../src/recruiter-list.mjs';
import {renameWithRetry} from '../src/monitor-store.mjs';
const now=Date.parse('2026-11-10T18:15:00+08:00'),config={recentWindowHours:24,mode:'automatic',acceptedTitles:['数值策划'],maxConversations:200};
test('Shanghai 24-hour boundaries and unknown dates',()=>{
 for(const label of ['18:01','昨天 19:00','刚刚','5分钟前','11月10日'])assert.equal(isRecentRow({displayTime:label},config,now),true,label);
 for(const label of ['昨天 17:00','11月06日','unknown',''])assert.equal(isRecentRow({displayTime:label},config,now),false,label);
 assert.equal(activityWindow('18:01',now).start,Date.parse('2026-11-10T18:01:00+08:00'));
});
test('old row newly exposed by scroll is not admitted; actual recent reply is admitted',()=>{
 const s={account:null,conversations:{},runtime:{listBaselineEstablished:true},controls:{},events:[],notifications:[]};
 const row={domRowId:'1',name:'候选人',jobTitle:'数值策划',displayTime:'11月06日',lastMessagePreview:'你好',unreadCount:1};
 ingestSnapshot(s,{account:{displayName:'招聘员'},rows:[row]},config,now);assert.equal(s.conversations['1'].admitted,false);
 ingestSnapshot(s,{account:{displayName:'招聘员'},rows:[{...row,displayTime:'18:14',lastMessagePreview:'您好，有空的'}]},config,now);assert.equal(s.conversations['1'].admitted,true);
});
test('unchanged own outbound is not repeatedly opened, fresh peer reply is inspected',()=>{
 const c={needsDetail:true,row:{displayTime:'18:01',lastMessagePreview:'问卷有空做吗',unreadCount:0},messages:[{direction:'outgoing',text:'问卷有空做吗'}]};
 assert.equal(shouldInspectConversation(c,config,now),false);c.row.lastMessagePreview='有空的';c.row.unreadCount=1;assert.equal(shouldInspectConversation(c,config,now),true);
});
test('virtualized selected row is tolerable only with the same verified detail header',()=>{
 const p={account:{displayName:'A'},filters:{},sourceUrl:'https://www.zhipin.com/web/chat/index',selectedRow:'1',selectedHeader:{name:'张',jobTitle:'数值策划'}};
 assert.equal(sameListContext({...p,selectedRow:null},contextKey(p)),true);
 assert.equal(sameListContext({...p,selectedRow:'2'},contextKey(p)),false);
 assert.equal(sameListContext({...p,selectedRow:null,selectedHeader:{name:'李',jobTitle:'数值策划'}},contextKey(p)),false);
});
test('atomic state replacement retries transient Windows sharing violations, never deletes destination',async()=>{
 let attempts=0;await renameWithRetry('from','to',{renameFn:async()=>{if(++attempts<3)throw Object.assign(Error(),{code:'EPERM'});},delay:async()=>{}});assert.equal(attempts,3);
 await assert.rejects(renameWithRetry('a','b',{renameFn:async()=>{throw Object.assign(Error(),{code:'ENOSPC'});},delay:async()=>{}}),{code:'ENOSPC'});
});
