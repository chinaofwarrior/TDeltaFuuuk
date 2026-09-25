// 时间比位置更重要（《开发方案》第十五节）。
// 提供：墙钟时间、单调时间（高精度）、以及多机时钟偏移估计（NTP 式 ping 交换）。

import { performance } from 'node:perf_hooks';

export function wallMs() {
  return Date.now();
}

export function monotonicMs() {
  return performance.now();
}

export function monotonicUs() {
  return Number(process.hrtime.bigint() / 1000n);
}

export class Clock {
  constructor() {
    this.startWallMs = Date.now();
    this.startMonoMs = monotonicMs();
  }

  // 由本机单调时间换算到"Hub 时间线"（墙钟）。用于跨机统一时间戳。
  toWall(localMonoMs) {
    return this.startWallMs + (localMonoMs - this.startMonoMs);
  }
}

/**
 * 时钟同步器：通过 ping 交换估计 RTT 与 offset。
 * 用法（Agent 侧）：
 *   const r = await sync.roundTrip(() => hubTimeNow());
 * 其中 hubTimeNow() 返回远端（Hub）的单调/墙钟时间戳。
 */
export class ClockSync {
  constructor() {
    this.offsetMs = 0;
    this.rttMs = 0;
    this.samples = 0;
  }

  // 一次往返：t1(本机) -> 远端 t2 -> t3(本机)
  record(t1Ms, remoteMs, t3Ms) {
    const rtt = t3Ms - t1Ms;
    const offset = remoteMs - (t1Ms + t3Ms) / 2;
    // 简单指数平滑
    const k = 0.25;
    this.rttMs = this.rttMs === 0 ? rtt : this.rttMs * (1 - k) + rtt * k;
    this.offsetMs = this.offsetMs === 0 ? offset : this.offsetMs * (1 - k) + offset * k;
    this.samples += 1;
    return { offsetMs: this.offsetMs, rttMs: this.rttMs };
  }

  toHub(localMs) {
    return localMs + this.offsetMs;
  }
}
