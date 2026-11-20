import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

const invalid = () => Object.assign(new Error('技能配置格式无效，请检查 config.json 的 model 和 assessment 字段。'), {code:'SKILL_CONFIG_INVALID'});
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Load only model settings and the local assessment source; never merge operational permissions. */
export async function applySkillConfig(config, baseDir) {
  const file = config.model?.configFile;
  if (file === undefined) return config;
  if (typeof file !== 'string' || !file.trim()) throw invalid();
  const configFile = resolve(baseDir, file);
  let raw;
  try { raw = await readFile(configFile, 'utf8'); }
  catch { throw Object.assign(new Error('无法读取技能配置文件，请检查 model.configFile 路径。'), {code:'SKILL_CONFIG_UNAVAILABLE'}); }
  let doc;
  // Never expose JSON parser excerpts: they may include an API key.
  try { doc = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch { throw invalid(); }
  if (!object(doc) || !object(doc.model)) throw invalid();
  const model = doc.model;
  if (typeof model.enabled !== 'boolean' || model.protocol !== 'openai-compatible'
      || !['baseUrl','name','apiKey'].every(key => typeof model[key] === 'string')
      || (model.allowPrivateHttp !== undefined && typeof model.allowPrivateHttp !== 'boolean')
      || (model.timeoutMs !== undefined && (!Number.isInteger(model.timeoutMs) || model.timeoutMs < 50 || model.timeoutMs > 120000))) throw invalid();
  const assessment = doc.assessment;
  if (assessment !== undefined && (!object(assessment) || typeof assessment.filePath !== 'string'
      || !isAbsolute(assessment.filePath) || !/\.xlsx$/i.test(assessment.filePath))) throw invalid();
  if(assessment?.url!==undefined&&typeof assessment.url!=='string')throw invalid();
  if(assessment?.delivery!==undefined&&!['file','link'].includes(assessment.delivery))throw invalid();
  if(doc.workflow!==undefined&&(!object(doc.workflow)||typeof doc.workflow.prompt!=='string'||typeof doc.workflow.requirements!=='string'||doc.workflow.prompt.length>16000||doc.workflow.requirements.length>16000))throw invalid();
  const effective = {
    source:'file', configFile, enabled:model.enabled, protocol:model.protocol,
    baseUrl:model.baseUrl.trim(), name:model.name.trim(), timeoutMs:model.timeoutMs ?? 30000,
    allowPrivateHttp:model.allowPrivateHttp === true,
  };
  Object.defineProperty(effective, 'apiKey', {value:model.apiKey.trim(), enumerable:false});
  return {...config, model:effective, ...(doc.workflow?{workflow:doc.workflow}:{}),
    ...(assessment ? {assessment:{filePath:assessment.filePath,url:assessment.url||'', delivery:assessment.delivery||'file',updatedAt:assessment.updatedAt||null}} : {})};
}
