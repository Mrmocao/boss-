#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig, projectRoot } from './config.mjs';
import { launchBrowser, portAvailable } from './launcher.mjs';
import { listTargets, chooseBossTarget, CdpSession, isBossUrl } from './cdp.mjs';
import { probePage } from './page-status.mjs';
import { createListAdapter, scanRecruiterList } from './recruiter-list.mjs';
import { saveCollection } from './collection-store.mjs';
import { resolveRecruiterTarget } from './browser-registry.mjs';

const help = {
  version: '0.2.0', phase: 'read-only-list-collection',
  commands: {
    doctor: '检查 Node、Chrome、本机端口；不启动浏览器。',
    login: '打开专用 Chrome，由用户自行登录。',
    status: '只读检测页面状态；可选 --target <id> 指定 BOSS 标签页。',
    tabs: '列出专用浏览器中的 BOSS 标签页 ID 和页面路径，不输出其他网站标签页。',
    collect: '仅公司配置：滚动读取当前筛选的沟通列表并保存本地，不打开会话、不发送消息。',
  },
  notImplemented: ['read_conversation', 'send_message', 'MCP server'],
  options: { '--profile personal|company|company-2': '选择独立浏览器目录；company-2 是第二个招聘账号；默认 personal。', '--target <id>': 'status / collect 支持。', '--max-steps <1..500>': 'collect 滚动读取次数上限，默认 120。' },
};

async function main() {
  const [command = 'help', ...args] = process.argv.slice(2);
  if (['help', '--help', '-h'].includes(command)) return help;
  if (!Object.hasOwn(help.commands, command)) throw Object.assign(new Error('Unknown command. Run help.'), { code: 'INVALID_COMMAND' });
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!['--profile', '--target', '--max-steps'].includes(key) || !value || value.startsWith('--') || Object.hasOwn(options, key)
        || (key === '--target' && !['status','collect'].includes(command))
        || (key === '--max-steps' && (command !== 'collect' || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 500))) {
      throw Object.assign(new Error('Invalid options. Run help for supported arguments.'), { code: 'INVALID_ARGUMENTS' });
    }
    options[key] = value;
  }
  const config = loadConfig({ ...process.env, ...(options['--profile'] ? { BOSS_PROFILE: options['--profile'] } : {}) });
  if (command === 'collect' && !['company','company-2'].includes(config.profile)) throw Object.assign(new Error('Collection requires --profile company or company-2.'), { code:'COMPANY_PROFILE_REQUIRED' });
  if (Number(process.versions.node.split('.')[0]) < 22) throw Object.assign(new Error('Node 22+ required.'), { code: 'NODE_VERSION' });
  if (command === 'doctor') {
    const available = await portAvailable(config.port);
    const chromeFound = Boolean(config.chromePath && existsSync(config.chromePath));
    return { profile: config.profile, state: chromeFound ? 'ENVIRONMENT_READY' : 'CHROME_NOT_FOUND', node: process.version,
      chromeFound, endpoint: config.endpoint, portAvailable: available, browserStartedByCommand: false,
      accountChecked: false, profileDir: config.profileDir, sendsMessages: false };
  }
  if (command === 'login') return { profile: config.profile, ...await launchBrowser(config) };
  let launch;
  try { launch = JSON.parse(await readFile(join(config.runtimeDir, 'launch.json'), 'utf8')); } catch { /* Missing launch record. */ }
  if (launch?.endpoint !== config.endpoint || launch?.profileDir !== config.profileDir) {
    throw Object.assign(new Error('No matching launch record for this profile and port. Run login for the selected profile; do not reuse another account endpoint.'), { code: 'PROFILE_CONNECTION_UNVERIFIED' });
  }
  const targets = await listTargets(config.endpoint);
  if (command === 'tabs') return { profile: config.profile, browserConnected: true,
    pages: targets.filter(t => t.type === 'page' && isBossUrl(t.url)).map(t => ({
      targetId: t.id, url: new URL(t.url).origin + new URL(t.url).pathname,
    })), sendsMessages: false };
  const target = config.profile === 'personal' ? chooseBossTarget(targets, options['--target'])
    : (await resolveRecruiterTarget({config,targetId:options['--target']})).target;
  const session = new CdpSession(target.webSocketDebuggerUrl, { endpoint: config.endpoint });
  try {
    await session.connect();
    if (command === 'collect') {
      const snapshot = await scanRecruiterList(createListAdapter(session), {
        maxSteps: options['--max-steps'] ? Number(options['--max-steps']) : 120,
      });
      const stored = await saveCollection({ rootDir:join(projectRoot,'.local','collections'), profile:config.profile, snapshot });
      return { status:'COLLECTION_SAVED', profile:config.profile, targetId:target.id,
        data:{ paths:stored.paths, stats:stored.stats, snapshotHash:stored.snapshotHash, archiveReused:stored.archiveReused },
        scope:snapshot.scope, sendsMessages:false };
    }
    const result = { profile: config.profile, checkedAt: new Date().toISOString(), browserConnected: true,
      targetId: target.id, ...await probePage(session, target) };
    const { targetId, ...summary } = result;
    await writeFile(join(config.runtimeDir, 'session-status.json'), JSON.stringify(summary, null, 2));
    return result;
  } finally { session.close(); }
}

try { console.log(JSON.stringify(await main(), null, 2)); }
catch (error) {
  console.error(JSON.stringify({ state: 'STOPPED', code: error.code || 'CONNECTOR_ERROR',
    message: error.message, sendsMessages: false }, null, 2));
  process.exitCode = 1;
}
