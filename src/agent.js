// TDeltaAgent 主程序（玩家实时观察数据网关，《原理》第九节）。
// 功能：自动发现 Hub、加载 Provider 插件、本机 UDP/HTTP ingest、
//      观测总线(事件驱动 + 20Hz 汇聚)、时钟同步、自动重连。

import http from 'node:http';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { ProviderManager } from './providers/manager.js';
import { DiscoveryClient, HubClient, UdpIngestServer, PORTS } from './transport/net.js';
import { ClockSync } from './core/clock.js';
import { normalize } from './core/observation.js';
import { RingBuffer } from './core/ringbuffer.js';
import { loadConfig, logger, saveJson } from './util.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const DEFAULTS = {
  sharedToken: '',
  hubUrl: '',
  agentId: '',
  providersDir: join(ROOT, 'src', 'providers'),
  agentHttpPort: PORTS.AGENT_HTTP,
  agentUdpPort: PORTS.AGENT_UDP,
  flushIntervalMs: 50, // 20Hz
  clockSyncIntervalMs: 5000,
};

export class Agent {
  constructor(configPath) {
    this.configPath = configPath || join(ROOT, 'TDeltaAgent.config.json');
    this.config = loadConfig(this.configPath, DEFAULTS);
    this.agentId = this.config.agentId || os.hostname();
    this.queue = new RingBuffer(4096); // SPSC 环形缓冲（《方案》§8）
    this.flushTimer = null;
    this.clockSync = new ClockSync();
    this.hubClient = null;
    this.providers = null;
    this.httpServer = null;
    this.udpServer = null;
  }

  async start() {
    logger.info('agent', `Agent ID: ${this.agentId}`);

    // 1. 发现 Hub
    let hubUrl = this.config.hubUrl;
    if (!hubUrl) {
      const found = await new DiscoveryClient({}).findHub();
      if (found) {
        hubUrl = `http://${found.hub_ip}:${found.hub_http_port}`;
        if (!this.config.sharedToken && found.token) this.config.sharedToken = found.token;
      }
    }
    if (!hubUrl) {
      logger.warn('agent', '未发现 Hub，稍后重试（可用 hubUrl 手动指定）');
    }

    this.hubClient = new HubClient({
      hubUrl,
      token: this.config.sharedToken,
      agentId: this.agentId,
      onState: (s) => logger.info('agent', `与 Hub: ${s}`),
    });
    this.hubClient.clockSync = this.clockSync;

    // 2. 启动 Provider（手动报点等）
    this.providers = new ProviderManager({
      providersDir: this.config.providersDir,
      onObservation: (raw) => this.push(raw),
    });
    this.providers.startAll();

    // 3. 本机 ingest：HTTP + UDP
    this.httpServer = http.createServer((req, res) => this.routeHttp(req, res));
    this.httpServer.listen(this.config.agentHttpPort, '127.0.0.1', () => {
      logger.info('agent', `本机 HTTP ingest: http://127.0.0.1:${this.config.agentHttpPort}/ingest`);
    });
    this.udpServer = new UdpIngestServer({ port: this.config.agentUdpPort, onData: (d) => this.push(d) });
    this.udpServer.start();

    // 4. 事件驱动 + 20Hz 汇聚
    this.flushTimer = setInterval(() => this.flush(), this.config.flushIntervalMs);

    // 5. 时钟同步 + 重连
    setInterval(() => this.reconcile(), this.config.clockSyncIntervalMs);

    logger.info('agent', 'Agent 启动完成');
  }

  routeHttp(req, res) {
    if (req.method === 'POST' && req.url === '/ingest') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try {
          const j = JSON.parse(body);
          if (Array.isArray(j.observations)) j.observations.forEach((o) => this.push(o));
          else if (j.observation) this.push(j.observation);
          else if (j.type) this.push(j);
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
    res.end(JSON.stringify({ ok: true, agent: this.agentId }));
  }

  push(raw) {
    try {
      const obs = normalize({ ...raw, observer_id: raw.observer_id || this.agentId });
      this.queue.push(obs);
    } catch (e) {
      logger.warn('agent', `丢弃 observation: ${e.message}`);
    }
  }

  async flush() {
    if (this.queue.size === 0 || !this.hubClient || !this.hubClient.hubUrl) return;
    const batch = this.queue.drain();
    await this.hubClient.sendObservations(batch);
  }

  async reconcile() {
    if (!this.hubClient || !this.hubClient.hubUrl) {
      // 重新发现
      const found = await new DiscoveryClient({}).findHub();
      if (found) {
        this.hubClient.hubUrl = `http://${found.hub_ip}:${found.hub_http_port}`;
        logger.info('agent', `重新发现 Hub: ${this.hubClient.hubUrl}`);
      }
    }
    await this.hubClient.syncClock();
  }

  stop() {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.providers) this.providers.stopAll();
    if (this.udpServer) this.udpServer.stop();
    if (this.httpServer) this.httpServer.close();
  }
}

// ---- 入口 ----
if (process.argv[1] && process.argv[1].endsWith('agent.js')) {
  const agent = new Agent();
  agent.start().catch((e) => {
    logger.error('agent', `启动失败: ${e.message}`);
    process.exit(1);
  });
  process.on('SIGINT', () => { agent.stop(); process.exit(0); });
  process.on('SIGTERM', () => { agent.stop(); process.exit(0); });
}
