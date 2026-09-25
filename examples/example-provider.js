// 示例 Provider：演示 Provider 协议与 20Hz 位置流 + 稀疏事件。
// 放在 examples/ 下，不会被 ProviderManager 自动发现（避免合成数据干扰）。
// 独立运行： node examples/example-provider.js

import { encodeMsg, ABI_VERSION } from '../src/providers/protocol.js';
import { monotonicUs } from '../src/core/clock.js';
import { wallMs } from '../src/core/clock.js';

const PROVIDER = 'ExampleProvider';
const RATE_HZ = 20;

function round(n) {
  return Math.round(n * 100) / 100;
}

function main() {
  process.stdout.write(encodeMsg({
    type: 'hello',
    provider: PROVIDER,
    abi: ABI_VERSION,
    capabilities: ['SELF_POSITION', 'SELF_HEADING', 'SELF_HEALTH'],
    max_rate_hz: RATE_HZ,
  }));

  let x = 100;
  let y = 100;
  let heading = 0;
  let hp = 100;
  let tick = 0;

  const heartbeatTimer = setInterval(() => {
    process.stdout.write(encodeMsg({ type: 'heartbeat' }));
  }, 2000);

  const simTimer = setInterval(() => {
    tick += 1;
    heading = (heading + 3) % 360;
    x += Math.cos((heading * Math.PI) / 180) * 0.6;
    y += Math.sin((heading * Math.PI) / 180) * 0.6;
    if (tick % 100 === 0) hp = Math.max(20, hp - 5);

    process.stdout.write(encodeMsg({
      type: 'observation',
      observation: {
        type: 'ENTITY_STATE',
        subject: { kind: 'SELF', id: 'T1' },
        position: { x: round(x), y: round(y), z: 0, floor: 1 },
        heading: round(heading),
        hp,
        max_hp: 100,
        source: 'AUTHORIZED_SDK',
        confidence: 1.0,
        timestamp_monotonic_us: monotonicUs(),
        timestamp_wall_ms: wallMs(),
      },
    }));
  }, 1000 / RATE_HZ);

  const contactTimer = setInterval(() => {
    process.stdout.write(encodeMsg({
      type: 'observation',
      observation: {
        type: 'CONTACT',
        subject: { kind: 'OBSERVED_ENEMY', id: `E-${tick}` },
        bearing: round(Math.random() * 360),
        distance_estimate: round(10 + Math.random() * 40),
        source: 'VISIBLE_UI',
        confidence: round(0.6 + Math.random() * 0.3),
        timestamp_monotonic_us: monotonicUs(),
        timestamp_wall_ms: wallMs(),
      },
    }));
  }, 5000);

  function shutdown() {
    clearInterval(heartbeatTimer);
    clearInterval(simTimer);
    clearInterval(contactTimer);
    process.exit(0);
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (process.argv[1] && process.argv[1].endsWith('example-provider.js')) {
  main();
}
