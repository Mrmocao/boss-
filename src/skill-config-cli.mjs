import { stat, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { readMonitorConfig } from './monitor-daemon.mjs';
import { getModelSettings } from './monitor-model.mjs';
import {questionnaireUrl} from './recruiting-workflow.mjs';

try {
  const config = await readMonitorConfig();
  const settings = getModelSettings(config);
  const assessment = {filePath:config.assessment?.filePath ?? null, readable:false, delivery:config.assessment?.delivery||'file',linkRequired:config.assessment?.delivery==='link',linkConfigured:!!questionnaireUrl(config),autoSendEnabled:false,platformUpload:'verify_after_candidate_consent'};
  if (assessment.filePath) {
    try {
      await access(assessment.filePath, constants.R_OK);
      const info = await stat(assessment.filePath);
      assessment.readable = info.isFile();
      assessment.sizeBytes = info.size;
    } catch { assessment.error = 'ASSESSMENT_FILE_UNAVAILABLE'; }
  }
  assessment.autoSendEnabled=config.mode==='automatic'&&config.allowAssessment===true&&(assessment.delivery==='file'?assessment.readable:assessment.linkConfigured);
  console.log(JSON.stringify({
    configFile:config.model.configFile ?? null,
    model:{source:config.model.source ?? 'environment', enabled:config.model.enabled,
      ready:settings.ready, missing:settings.missing, invalid:settings.invalid},
    assessment,service:{mode:config.mode,replyQuietMs:config.debounceMs,automaticSend:config.allowSend}, networkRequestMade:false,
  }, null, 2));
} catch (e) {
  console.error(JSON.stringify({code:e.code || 'CONFIG_CHECK_FAILED', message:'配置读取失败，请检查技能配置文件的格式与路径。'}));
  process.exitCode = 1;
}
