const DAY=86400000,OFFSET=8*3600000;
/** Display labels are interpreted in Asia/Shanghai. Unknown/coarse dates never invent activity. */
export function activityWindow(label,now=Date.now()) {
  const value=String(label||'').trim(),local=new Date(now+OFFSET),day=Date.UTC(local.getUTCFullYear(),local.getUTCMonth(),local.getUTCDate())-OFFSET;
  if(/^(刚刚|现在)$/.test(value))return {start:now-60000,end:now};
  let m=/^(\d+)\s*分钟前$/.exec(value);if(m)return {start:now-(Number(m[1])+1)*60000,end:now-Number(m[1])*60000};
  m=/^(\d+)\s*小时前$/.exec(value);if(m)return {start:now-(Number(m[1])+1)*3600000,end:now-Number(m[1])*3600000};
  m=/^(今天|昨日|昨天)?\s*(\d{1,2}):(\d{2})$/.exec(value);
  if(m){const hour=Number(m[2]),minute=Number(m[3]);if(hour>23||minute>59)return null;let t=day+hour*3600000+minute*60000;if(m[1]==='昨天'||m[1]==='昨日')t-=DAY;else if(!m[1]&&t>now+60000)t-=DAY;return {start:t,end:t+59999};}
  if(value==='昨天'||value==='昨日')return {start:day-DAY,end:day-1};
  if(value==='今天')return {start:day,end:now};
  m=/^(?:(\d{4})[年/-])?(\d{1,2})[月/-](\d{1,2})日?$/.exec(value);
  if(m){let year=m[1]?Number(m[1]):local.getUTCFullYear();let start=Date.UTC(year,Number(m[2])-1,Number(m[3]))-OFFSET;if(!m[1]&&start>now)start=Date.UTC(year-1,Number(m[2])-1,Number(m[3]))-OFFSET;return {start,end:start+DAY-1};}
  return null;
}
export function isRecentRow(row,config,now=Date.now(),record) {
  if(!config.recentWindowHours)return true;
  const cutoff=now-config.recentWindowHours*3600000;
  const range=activityWindow(row?.displayTime,now);
  if(range&&range.end<cutoff)return false;
  // Only a change observed while running counts as fresh; initially opening history does not.
  if(record?.lastLiveChangeAt>=cutoff)return true;
  return !!range && range.end>=cutoff && range.start<=now;
}
export function shouldInspectConversation(c,config,now=Date.now()) {
  if(!isRecentRow(c.row,config,now,c))return false;
  const last=c.messages?.findLast(m=>['incoming','outgoing','unknown'].includes(m.direction));
  if(config.recentWindowHours&&last?.direction==='outgoing'&&c.row?.lastMessagePreview===last.text&&!(Number(c.row?.unreadCount)>0))return false;
  if(!c.needsDetail&&c.messages?.findLast(m=>['incoming','outgoing','unknown'].includes(m.direction))?.direction==='outgoing')return false;
  return true;
}
