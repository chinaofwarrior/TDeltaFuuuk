// 手动报点 Provider（《原理》第五节 A：玩家主动输入）。
// 热键需要全局键盘钩子（原生模块），这里用「本地 HTTP 端点 + stdin」等价实现：
//   - HTTP: POST http://127.0.0.1:17900/report  {"type":"enemy_report","sector":"north_building_2f","count":2,"confidence":0.95}
//   - stdin: 每行一个 JSON 命令（由外部热键/语音脚本写入）
// 将命令转换为统一 Observation。会被 ProviderManager 按 *.provider.js 自动发现加载。

import http from 'node:http';
import { createInterface } from 'node:readline';
import { encodeMsg, ABI_VERSION } from './protocol.js';
import { monotonicUs } from '../core/clock.js';
import { wallMs } from '../core/clock.js';

const PORT = Number(process.env.MANUAL_PORT || 17900);
const PROVIDER = 'ManualProvider';

// 命令 → Observation 映射
function commandToObservation(cmd) {
  if (!cmd || typeof cmd !== 'object') return null;
  const base = {
    source: 'MANUAL',
    observer_id: cmd.observer_id || 'self',
    timestamp_monotonic_us: monotonicUs(),
    timestamp_wall_ms: wallMs(),
  };
  switch (cmd.type) {
    case 'enemy_report':
      return { ...base, type: 'ENEMY_REPORT', subject: { kind: 'OBSERVED_ENEMY', id: cmd.id || 'E-MANUAL' }, sector: cmd.sector, count: cmd.count ?? 1, confidence: cmd.confidence ?? 0.9 };
    case 'status':
      return { ...base, type: 'STATUS', subject: { kind: 'SELF', id: cmd.id || 'T1' }, hp: cmd.hp, ammo: cmd.ammo, medkits: cmd.medkits };
    case 'audio_report':
      return { ...base, type: 'AUDIO_CONTACT', bearing: cmd.bearing, class: cmd.class || 'footstep', confidence: cmd.confidence ?? 0.8 };
    default:
      return null;
  }
}

function main() {
  process.stdout.write(encodeMsg({
    type: 'hello',
    provider: PROVIDER,
    abi: ABI_VERSION,
    capabilities: ['ENEMY_CONTACT'],
    max_rate_hz: 10,
  }));

  const emit = (cmd) => {
    const obs = commandToObservation(cmd);
    if (obs) process.stdout.write(encodeMsg({ type: 'observation', observation: obs }));
  };

  const heartbeatTimer = setInterval(() => process.stdout.write(encodeMsg({ type: 'heartbeat' })), 2000);

  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/report') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try {
          emit(JSON.parse(body));
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, usage: 'POST /report {"type":"enemy_report",...}' }));
  });
  server.listen(PORT, '127.0.0.1', () => {
    process.stderr.write(`ManualProvider HTTP 端点: http://127.0.0.1:${PORT}/report\n`);
  });

  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    try { emit(JSON.parse(line)); } catch {}
  });

  function shutdown() {
    clearInterval(heartbeatTimer);
    server.close();
    process.exit(0);
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (process.argv[1] && process.argv[1].endsWith('manual.provider.js')) {
  main();
}
