import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

function fail(message) {
  return Object.assign(new Error(message), { code: 'INVALID_COLLECTION' });
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hash(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

async function atomicWrite(path, content) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  // Excel can interpret leading control/whitespace before a formula; neutralize the cell.
  if (/^[\s\u0000-\u001f]*[=+@-]/u.test(text) || /^[\t\r\n]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function md(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').replaceAll('|', '\\|').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function countBy(rows, field) {
  const result = Object.create(null);
  for (const row of rows) {
    const value = typeof row[field] === 'string' && row[field].trim() ? row[field] : '未知';
    result[value] = (result[value] || 0) + 1;
  }
  return result;
}

function validate(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw fail('snapshot must be an object.');
  if (!snapshot.account || typeof snapshot.account.displayName !== 'string' || !snapshot.account.displayName.trim()) {
    throw fail('A non-empty observed account displayName is required.');
  }
  if (!Array.isArray(snapshot.rows) || snapshot.rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) {
    throw fail('rows must be an array of observed row objects.');
  }
  if (!snapshot.scope || typeof snapshot.scope !== 'object' || Array.isArray(snapshot.scope)) throw fail('scope must describe the observed list coverage.');
  if (typeof snapshot.collectedAt !== 'string' || !Number.isFinite(Date.parse(snapshot.collectedAt))) throw fail('collectedAt must be a valid date string.');
  const source = new URL(snapshot.sourceUrl);
  if (source.origin !== 'https://www.zhipin.com' || source.username || source.password) throw fail('sourceUrl must be an HTTPS BOSS URL.');
  return source.origin + source.pathname;
}

/** Store observed rows without treating a name as a stable person/account identifier. */
export async function saveCollection({ rootDir, profile, snapshot }) {
  if (typeof rootDir !== 'string' || !isAbsolute(rootDir)) throw fail('rootDir must be an absolute local collection directory.');
  if (!['company', 'company-2', 'personal'].includes(profile)) throw fail('profile must be company, company-2 or personal.');
  const sourceUrl = validate(snapshot);
  // JSON round-trip strips undefined values consistently before hashing and serializing.
  const clean = JSON.parse(JSON.stringify({ ...snapshot, sourceUrl }));
  const namespace = hash({ profile, displayName: clean.account.displayName }).slice(0, 16);
  const accountContext = { profile, namespace, displayName: clean.account.displayName,
    identityConfidence: 'display_only', stableAccountId: null,
    warning: '显示名命名空间为弱身份；同名账号无法可靠隔离，不能作为平台账号 ID。' };
  const content = { schemaVersion: 1, accountContext, account: clean.account,
    sourceUrl, scope: clean.scope, rows: clean.rows };
  const snapshotHash = hash(content);
  const directory = join(rootDir, profile, namespace);
  const snapshotsDir = join(directory, 'snapshots');
  await mkdir(snapshotsDir, { recursive: true });
  const paths = {
    directory, latest: join(directory, 'latest.json'),
    archive: join(snapshotsDir, `${snapshotHash}.json`),
    csv: join(directory, 'candidates.csv'), summary: join(directory, 'summary.md'),
  };
  const stats = {
    rowCount: clean.rows.length,
    uniquePersonCount: null,
    confirmedApplicantCount: null,
    jobDistribution: countBy(clean.rows, 'jobTitle'),
    missing: Object.fromEntries(['name', 'jobTitle', 'displayTime', 'lastMessagePreview', 'platformCandidateId']
      .map(field => [field, clean.rows.filter(row => row[field] === null || row[field] === undefined || row[field] === '').length])),
    rowsWithUnreadBadge: clean.rows.filter(row => Number.isSafeInteger(row.unreadCount) && row.unreadCount > 0).length,
    unreadCountKnownRows: clean.rows.filter(row => Number.isSafeInteger(row.unreadCount) && row.unreadCount >= 0).length,
  };
  const result = { ...content, collectedAt: clean.collectedAt, snapshotHash, stats,
    warnings: [accountContext.warning,
      '这是沟通候选人列表，不代表已确认投递简历；不按姓名合并人员。',
      '列表摘要不是完整聊天历史。快照内容去重不是候选人身份或消息精确去重。'],
    sendsMessages: false };
  let archiveReused = false;
  try {
    const prior = JSON.parse(await readFile(paths.archive, 'utf8'));
    const { collectedAt, snapshotHash: priorHash, stats: priorStats, warnings, sendsMessages, ...priorContent } = prior;
    if (priorHash !== snapshotHash || hash(priorContent) !== snapshotHash) {
      throw Object.assign(new Error('Existing archive failed its integrity check; refusing to replace it.'), { code: 'ARCHIVE_INTEGRITY_ERROR' });
    }
    archiveReused = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await atomicWrite(paths.archive, JSON.stringify(result, null, 2));
  }
  const columns = [
    ['sourceIndex', '来源序号'], ['name', '候选人显示名'], ['jobTitle', '列表岗位'],
    ['displayTime', '页面时间'], ['unreadCount', '未读标记数'],
    ['lastMessagePreview', '列表消息摘要'], ['platformCandidateId', '平台候选人ID'],
  ];
  const csv = '\uFEFF' + [columns.map(([, title]) => csvCell(title)).join(','),
    ...clean.rows.map(row => columns.map(([field]) => csvCell(row[field])).join(','))].join('\r\n') + '\r\n';
  const summary = [
    '# 沟通候选人采集汇总', '',
    `采集时间：${md(clean.collectedAt)}。配置：${profile}。`, '',
    `本次记录 **${stats.rowCount} 行沟通候选人**，不按姓名合并；独立人数与已确认投递人数均未知。`, '',
    '## 岗位分布', '', '| 列表岗位 | 行数 |', '|---|---:|',
    ...Object.entries(stats.jobDistribution).map(([title, count]) => `| ${md(title)} | ${count} |`), '',
    '## 读取范围', '', '```json', JSON.stringify(clean.scope, null, 2).replaceAll('```', '\\u0060\\u0060\\u0060'), '```', '',
    '## 缺失信息与限制', '',
    ...Object.entries(stats.missing).map(([field, count]) => `- ${field}：${count} 行缺失。`),
    `- 有未读徽标的列表行：${stats.rowsWithUnreadBadge}；不等于待回复人数。`,
    '- 未采集字段保持未知，不根据消息摘要推断学历、薪资或筛选结论。',
    ...result.warnings.map(warning => `- ${warning}`),
    '- 数据仅保存在本地采集目录，没有发送招聘消息。', '',
    `快照内容哈希：${snapshotHash}`, '',
  ].join('\n');
  await atomicWrite(paths.csv, csv);
  await atomicWrite(paths.summary, summary);
  await atomicWrite(paths.latest, JSON.stringify(result, null, 2));
  return { paths, stats, snapshotHash, archiveReused, accountContext, sendsMessages: false };
}
