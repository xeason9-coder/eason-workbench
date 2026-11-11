import {readFileSync, openSync, closeSync, unlinkSync, writeFileSync, mkdirSync} from 'node:fs';
import {setTimeout} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const config = Object.fromEntries(readFileSync(path.join(root, 'KB/.dev.vars'), 'utf8').split(/\r?\n/).filter(line => /^[A-Z_]+=/.test(line)).map(line => {const at = line.indexOf('='); return [line.slice(0, at), JSON.parse(line.slice(at + 1))];}));
if (!config.FUSION_SERVICE_TOKEN || config.FUSION_LOCAL !== '1') throw Error('本地调度配置尚未就绪');
mkdirSync(path.join(root, 'runtime'), {recursive: true});
const lock = path.join(root, 'runtime/background.lock');
try {const fd = openSync(lock, 'wx'); closeSync(fd);} catch (e) {
  if (e.code !== 'EEXIST') throw e;
  const pid = Number(readFileSync(lock, 'utf8'));
  let alive = false;
  if (Number.isInteger(pid) && pid > 0) {try {process.kill(pid, 0); alive = true;} catch {}}
  if (alive) throw Error('后台调度已在运行，不能重复启动');
  unlinkSync(lock); const fd = openSync(lock, 'wx'); closeSync(fd);
}
writeFileSync(lock, String(process.pid));
let stop = false, connected = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {stop = true;});
process.on('exit', () => {try {if (Number(readFileSync(lock, 'utf8')) === process.pid) unlinkSync(lock);} catch {}});
do {
  try {
    const response = await fetch('http://127.0.0.1:5173/api/fusion/background/tick', {method: 'POST', headers: {Authorization: 'Bearer ' + config.FUSION_SERVICE_TOKEN}, signal: AbortSignal.timeout(180000)});
    if (!response.ok) throw Error('HTTP ' + response.status);
    const result = await response.json();
    if (!connected) {console.log('后台调度已连接'); connected = true;}
    for (const job of result.processed || []) console.log(new Date().toISOString(), '任务', job.id, job.state || '未完成', job.stage || '', job.error ? '需人工处理' : '');
  } catch (e) {console.error(new Date().toISOString(), '后台调度未完成：', e.message);}
  if (!stop && !process.argv.includes('--once')) await setTimeout(5000);
} while (!stop && !process.argv.includes('--once'));
