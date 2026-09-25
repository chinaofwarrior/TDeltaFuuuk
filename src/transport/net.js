// 传输层：UDP 局域网自动发现、UDP/HTTP ingest、Agent→Hub 客户端。
// 端口约定（与原始 README 一致）：
//   Hub 控制台 HTTP 127.0.0.1:17888 | 队友上报 0.0.0.0:17889
//   局域网发现 UDP 17892 | Agent 本机 UDP 17890 | Agent 本机 HTTP 17891/ingest

import dgram from 'node:dgram';
import os from 'node:os';
import { logger } from '../util.js';

export const PORTS = {
  HUB_HTTP: 17888,
  HUB_INGEST: 17889,
  DISCOVERY: 17892,
  AGENT_UDP: 17890,
  AGENT_HTTP: 17891,
};

export const DISCOVER_MAGIC = 'TDF-DISCOVER-v1';

// ---- 局域网自动发现：Hub 侧应答 ----
export class DiscoveryServer {
  constructor({ hubHttpPort = PORTS.HUB_HTTP, name = 'TDeltaFuuuk-Hub', token = '' } = {}) {
    this.opts = { hubHttpPort, name, token };
    this.sock = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket('udp4');
      sock.on('error', (e) => reject(e));
      sock.on('message', (msg, rinfo) => {
        if (msg.toString() === DISCOVER_MAGIC) {
          const reply = Buffer.from(JSON.stringify({
            magic: DISCOVER_MAGIC,
            name: this.opts.name,
            hub_ip: localIp() || rinfo.address,
            hub_http_port: this.opts.hubHttpPort,
            ingest_port: PORTS.HUB_INGEST,
            token: this.opts.token,
          }));
          sock.send(reply, rinfo.port, rinfo.address);
        }
      });
      sock.bind(PORTS.DISCOVERY, '0.0.0.0', () => {
        sock.setBroadcast(true);
        this.sock = sock;
        logger.info('net', `发现服务监听 UDP ${PORTS.DISCOVERY}`);
        resolve();
      });
    });
  }

  stop() {
    if (this.sock) { try { this.sock.close(); } catch {} this.sock = null; }
  }
}

// ---- 局域网自动发现：Agent 侧搜索 ----
export class DiscoveryClient {
  constructor({ port = PORTS.DISCOVERY, timeoutMs = 2500 } = {}) {
    this.port = port;
    this.timeoutMs = timeoutMs;
  }

  findHub() {
    return new Promise((resolve) => {
      const sock = dgram.createSocket('udp4');
      const results = [];
      const timer = setTimeout(() => {
        try { sock.close(); } catch {}
        resolve(results[0] || null);
      }, this.timeoutMs);

      sock.on('message', (msg) => {
        try {
          const m = JSON.parse(msg.toString());
          if (m.magic === DISCOVER_MAGIC) results.push(m);
        } catch {}
      });
      sock.bind(() => {
        sock.setBroadcast(true);
        sock.send(Buffer.from(DISCOVER_MAGIC), this.port, '255.255.255.255');
      });
    });
  }
}

// ---- UDP ingest：解析 JSON 数据报 ----
export class UdpIngestServer {
  constructor({ port = PORTS.AGENT_UDP, onData } = {}) {
    this.port = port;
    this.onData = onData || (() => {});
    this.sock = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket('udp4');
      sock.on('error', reject);
      sock.on('message', (msg) => {
        try {
          const data = JSON.parse(msg.toString());
          this.onData(data);
        } catch (e) {
          logger.warn('net', `UDP ingest 解析失败: ${e.message}`);
        }
      });
      sock.bind(this.port, '127.0.0.1', () => {
        this.sock = sock;
        logger.info('net', `UDP ingest 监听 127.0.0.1:${this.port}`);
        resolve();
      });
    });
  }

  stop() {
    if (this.sock) { try { this.sock.close(); } catch {} this.sock = null; }
  }
}

// ---- Agent → Hub 客户端（HTTP JSON，自动重连） ----
export class HubClient {
  constructor({ hubUrl, token, agentId, onState = () => {} } = {}) {
    this.hubUrl = (hubUrl || '').replace(/\/$/, '');
    this.token = token || '';
    this.agentId = agentId || 'agent';
    this.onState = onState;
    this.connected = false;
    this.clockSync = null; // 由 agent 注入
  }

  async sendObservations(observations) {
    if (!this.hubUrl) return false;
    try {
      const res = await fetch(`${this.hubUrl}/api/ingest`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-tdf-token': this.token,
        },
        body: JSON.stringify({
          agent_id: this.agentId,
          observations: Array.isArray(observations) ? observations : [observations],
        }),
      });
      const ok = res.ok;
      this._setConnected(ok);
      return ok;
    } catch {
      this._setConnected(false);
      return false;
    }
  }

  // 时钟同步：向 Hub 请求其时间，估计 offset（《方案》§15）
  async syncClock() {
    if (!this.hubUrl || !this.clockSync) return;
    const t1 = Date.now();
    try {
      const res = await fetch(`${this.hubUrl}/api/time`, { headers: { 'x-tdf-token': this.token } });
      const j = await res.json();
      const t3 = Date.now();
      this.clockSync.record(t1, j.now_ms, t3);
    } catch {}
  }

  _setConnected(c) {
    if (c !== this.connected) {
      this.connected = c;
      this.onState(c ? 'connected' : 'disconnected');
      logger.info('net', `Hub 连接状态: ${c ? '已连接' : '断开'}`);
    }
  }
}

function localIp() {
  const ids = os.networkInterfaces();
  for (const name of Object.keys(ids)) {
    for (const ni of ids[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return null;
}
