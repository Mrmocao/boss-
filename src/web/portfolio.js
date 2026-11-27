'use strict';
const $ = id => document.getElementById(id);
const jobId = new URLSearchParams(location.search).get('job') || '';
const endpoint = '/api/portfolio/'+encodeURIComponent(jobId);
const token = document.querySelector('meta[name=csrf]').content;
const sourceKeys = ['chat','profile','resume'];
const sourceLabels = {chat:'候选人聊天',profile:'在线资料',resume:'简历'};
const fields = {level:'学历',enrollment:'在读状态',year:'毕业年份',grade:'年级',major:'专业',majorType:'专业方向',intent:'意向',experience:'经历',concern:'需核实',attachment:'附件请求',soft:'软性记录'};
let records = [], active = null, loaded = false;
function render(id) {
  active = records.find(row=>row.id===id) || records[0];
  $('cases').replaceChildren(...records.map(row=>new Option(row.name+' · '+row.account+' · '+row.stage,row.id)));
  $('empty').hidden=!!active;
  $('detail').hidden=!active;
  if (!active) {$('new').open=true;return;}
  $('cases').value=active.id;
  $('title').textContent=active.name+' · '+active.stage;
  $('note').textContent=active.note;
  for (const key of sourceKeys) $(key).value=active.sources[key]||'';
  const finished=['关闭','婉拒-学历','婉拒-专业'].includes(active.stage);
  const reviewing=active.stage==='转人工';
  $('source-fields').hidden=finished||reviewing||active.pending?.step==='S6';
  $('draft').hidden=!active.pending;
  $('step').textContent=(active.pending?.step||'')+' · 待人工发送';
  $('message').textContent=active.pending?.text||'';
  $('evidence').textContent=[
    ...Object.entries(active.facts).map(([key,f])=>fields[key]+' · '+f.value+'（'+sourceLabels[f.source]+'）\n'+f.quote),
    ...sourceKeys.filter(k=>active.sources[k]).map(k=>sourceLabels[k]+'\n'+active.sources[k])
  ].join('\n\n')||'尚无资料';
  $('handoff').hidden=reviewing||['关闭','婉拒-学历','婉拒-专业'].includes(active.stage);
  $('attachment').hidden=active.stage==='关闭';
  $('return').hidden=!reviewing;
  $('resolve').hidden=!reviewing||!['待判定','已追问'].includes(active.resumeStage);
  $('receipt').hidden=active.stage!=='已引导投递';
  $('has-resume').checked=$('has-portfolio').checked=false;
  $('review').hidden=active.stage!=='待批改';
  $('close').hidden=active.stage!=='已批改';
  $('history').replaceChildren(...active.history.map(h=>{
    const li=document.createElement('li');
    li.textContent=new Date(h.at).toLocaleString('zh-CN')+' · '+h.stage+' · '+h.note;
    return li;
  }));
}
function discard() {
  return !active||sourceKeys.every(k=>$(k).value===(active.sources[k]||''))||confirm('放弃本次未保存的资料修改？');
}
async function request(input) {
  const response=await fetch(endpoint,{method:input?'POST':'GET',headers:{'X-CSRF-Token':token,'Content-Type':'application/json'},
    body:input?JSON.stringify(input):undefined,cache:'no-store'});
  const result=await response.json();
  if (!response.ok) throw Error(response.status===409?'记录已更新，请刷新后再操作。':response.status===404?'请从无问卷岗位配置进入工作台。':'操作失败，请检查输入并重试。');
  return result;
}
async function busy(action) {
  $('controls').disabled=true;
  $('status').textContent='处理中…';
  try {await action();$('status').textContent='';}
  catch(e) {$('status').textContent=e.message;}
  finally {$('controls').disabled=!loaded;}
}
async function load() {
  await busy(async()=>{
    const data=await request();
    $('job').textContent=data.job;
    records=data.cases;
    loaded=true;
    render(active?.id);
  });
}
async function change(action,extra={}) {
  if (action!=='analyze'&&!discard()) return;
  await busy(async()=>{
    const {record}=await request({id:active?.id,revision:active?.revision,action,...extra});
    records=[record,...records.filter(row=>row.id!==record.id)];
    if (action==='create') {$('new').open=false;$('create').reset();}
    render(record.id);
  });
}
$('cases').onchange=()=>{if (discard()) render($('cases').value);else $('cases').value=active.id;};
$('reload').onclick=()=>{if (discard()) load();};
$('create').onsubmit=e=>{e.preventDefault();change('create',{name:$('name').value,account:$('account').value,reference:$('reference').value});};
$('analyze').onclick=()=>change('analyze',{sources:Object.fromEntries(sourceKeys.map(k=>[k,$(k).value]))});
$('copy').onclick=async()=>{try{await navigator.clipboard.writeText(active.pending.text);$('status').textContent='话术已复制。';}catch{$('status').textContent='请选中待发送话术并手动复制。';}};
$('sent').onclick=()=>change('sent',{step:active.pending.step});
$('attachment').onclick=()=>change('attachment');
$('handoff').onclick=()=>{const reason=prompt('填写转人工原因及最近消息');if (reason?.trim()) change('handoff',{reason});};
$('return').onclick=()=>change('resume');
$('resolve-action').onclick=()=>{const reason=prompt('填写人工复核依据');if(reason?.trim()) change('resolve',{step:$('decision').value,reason});};
$('received').onclick=()=>{
  if (!$('has-resume').checked||!$('has-portfolio').checked) {$('status').textContent='简历和作品集两项齐全后才能进入待批改。';return;}
  change('receipt',{resume:true,portfolio:true});
};
$('review').onclick=()=>change('review');
$('close').onclick=()=>change('close');
load();
