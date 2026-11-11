import {readFileSync, writeFileSync, existsSync, mkdirSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const repo = path.join(root, 'KB'), collector = path.join(root, 'we-mp-rss');
const configPath = path.join(repo, '.dev.vars');
if (existsSync(configPath)) {
  console.log('本地配置已存在，保留现有模型连接和加密主密钥。');
  process.exit(0);
}
const runtime = path.join(root, 'runtime');
mkdirSync(runtime, {recursive: true});
mkdirSync(path.join(collector, 'data'), {recursive: true});
const masterPath = path.join(runtime, 'model-encryption.key');
if (!existsSync(masterPath)) writeFileSync(masterPath, randomBytes(32).toString('hex'), {flag: 'wx', mode: 0o600});
const servicePath = path.join(collector, 'data/fusion-service.key');
if (!existsSync(servicePath)) writeFileSync(servicePath, randomBytes(32).toString('hex'), {flag: 'wx', mode: 0o600});
const settingsPath = path.join(collector, 'data/workbench-settings.json');
const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {};
const apiKey = process.env.DEEPSEEK_API_KEY || settings.api_key || '';
const config = {FUSION_LOCAL: '1', FUSION_COLLECTOR_URL: 'http://127.0.0.1:8768', FUSION_SERVICE_TOKEN: readFileSync(servicePath, 'utf8').trim(), MODEL_SETTINGS_ENCRYPTION_KEY: readFileSync(masterPath, 'utf8').trim(), AI_URL: apiKey ? 'https://api.deepseek.com/chat/completions' : '', AI_MODEL: apiKey ? settings.model || 'deepseek-flash' : '', AI_KEY: apiKey, AI_RESPONSE_FORMAT: 'json_object', FUSION_MODEL_OWNER: 'fusion-admin-model', FUSION_STORAGE_QUOTA_BYTES: String(512 * 1024 * 1024)};
writeFileSync(configPath, Object.entries(config).map(([k, v]) => k + '=' + JSON.stringify(v)).join('\n') + '\n', {flag: 'wx', mode: 0o600});
console.log('已创建本地服务配置；未输出密钥，未更改既有采集账号。');
if (!apiKey) console.log('模型尚未配置：启动后由管理员在页面设置，其他账号无需填写 API Key。');
