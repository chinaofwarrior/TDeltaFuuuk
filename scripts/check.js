// 语法/导入校验：动态 import 所有源模块，确保无语法错误与缺失导出。
// 运行： node scripts/check.js

const modules = [
  '../src/util.js',
  '../src/core/observation.js',
  '../src/core/clock.js',
  '../src/core/ringbuffer.js',
  '../src/providers/protocol.js',
  '../src/providers/manager.js',
  '../src/providers/manual.provider.js',
  '../examples/example-provider.js',
  '../src/fusion/engine.js',
  '../src/tactics/engine.js',
  '../src/transport/net.js',
  '../src/adapters/dfapi.js',
  '../src/hub.js',
  '../src/agent.js',
];

let failed = 0;
for (const m of modules) {
  try {
    await import(m);
    console.log('OK   ' + m);
  } catch (e) {
    failed++;
    console.error('FAIL ' + m + ' -> ' + e.message);
  }
}
if (failed) {
  console.error(`\n${failed} 个模块校验失败`);
  process.exit(1);
}
console.log('\n全部模块校验通过');
