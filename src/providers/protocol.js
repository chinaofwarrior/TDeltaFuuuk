// Provider 子进程协议（NDJSON over stdio）。
// 对应《开发方案》第三节的纯 C ABI，但用「子进程 + NDJSON」实现，
// 达到同等甚至更强的崩溃隔离（进程级）。sdk/tdf_provider.h 保留 C ABI 参考实现。

import { SUPPORT } from '../core/observation.js';

export const ABI_VERSION = 1;

export function encodeMsg(obj) {
  return JSON.stringify(obj) + '\n';
}

export function decodeLine(line) {
  line = line.trim();
  if (!line) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/**
 * 校验 Provider 握手（hello）消息，返回标准化后的能力契约。
 */
export function parseHello(msg) {
  if (!msg || msg.type !== 'hello') return null;
  const capabilities = Array.isArray(msg.capabilities) ? msg.capabilities : [];
  for (const c of capabilities) {
    if (!Object.values(SUPPORT).includes(c)) {
      return { error: `未知 capability: ${c}` };
    }
  }
  const abi = Number(msg.abi ?? 0);
  if (abi !== ABI_VERSION) {
    return { error: `ABI 不匹配: 期望 ${ABI_VERSION}，实际 ${abi}` };
  }
  return {
    abi,
    provider: String(msg.provider || 'unnamed'),
    capabilities,
    max_rate_hz: Number(msg.max_rate_hz ?? 50),
  };
}

// 能力契约：Provider 声明自己能产出什么，Hub/Agent 据此判断其输出是否越界。
export class CapabilityContract {
  constructor(capabilities) {
    this.capabilities = new Set(capabilities);
  }

  has(cap) {
    return this.capabilities.has(cap);
  }

  allows(cap) {
    return this.capabilities.has(cap);
  }
}
