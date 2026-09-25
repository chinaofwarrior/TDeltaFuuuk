// TDeltaFuuuk Hub 主程序。
// 功能：控制台 HTTP(127.0.0.1:17888) + 队友上报(0.0.0.0:17889) + SSE 实时推送
//      + 局域网发现(17892) + 融合/战术引擎 + DF 账号绑定。

import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import os from 'node:os';

import { FusionEngine } from './fusion/engine.js';
import { TacticsEngine } from './tactics/engine.js';
import { DiscoveryServer, PORTS } from './transport/net.js';
import { DFAccountAdapter } from './adapters/dfapi.js';
import { loadConfig, saveJson, CredentialStore, logger, genId, ensureDir } from './util.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const UI_DIR = join(ROOT, 'webui');

const DEFAULTS = {
  name: 'TDeltaFuuuk-Hub',
  sharedToken: '',
  hubHttpPort: PORTS.HUB_HTTP,
  ingestPort: PORTS.HUB_INGEST,
  discoveryPort: PORTS.DISCOVERY,
  dfBaseUrl: '',
  sseIntervalMs: 250,
};

export class Hub {
  constructor(configPath) {
    this.configPath = configPath || join(ROOT, 'tdelta-hub.json');
    this.config = loadConfig(this.configPath, DEFAULTS);
    if (!this.config.sharedToken) {
      this.config.sharedToken = genId('tk').toLowerCase().replace('_', '');
      saveJson(this.configPath, this.config);
    }
    this.accountsStore = new CredentialStore(join(ROOT, 'tdelta-accounts.enc.json'));
    this.accounts = this.accountsStore.load(); // { [accountId]: { token } }
    this.fusion = new FusionEngine({});
    this.tactics = new TacticsEngine({});
    this.sseClients = new Set();
    this.dfAdapters = {}; // accountId -> DFAccountAdapter
    this.accountProfiles = {}; // accountId -> 已拉取的账号资料
    this.discovery = new DiscoveryServer({ hubHttpPort: this.config.hubHttpPort, name: this.config.name, token: this.config.sharedToken });
    this.server = null;
    this.ingestServer = null;
    this.timers = [];
  }

  async start() {
    // 局域网发现
    await this.discovery.start();

    // 控制台 HTTP（loopback only，对应原始 README「只绑定 loopback」）
    this.server = http.createServer((req, res) => this.route(req, res));
    this.server.listen(this.config.hubHttpPort, '127.0.0.1', () => {
      logger.info('hub', `控制台: http://127.0.0.1:${this.config.hubHttpPort}`);
    });

    // 队友上报（0.0.0.0）
    this.ingestServer = http.createServer((req, res) => this.routeIngest(req, res));
    this.ingestServer.listen(this.config.ingestPort, '0.0.0.0', () => {
      logger.info('hub', `队友上报: 0.0.0.0:${this.config.ingestPort}`);
    });

    // 融合/战术引擎周期：衰减 + SSE 广播
    const loop = setInterval(() => this.tick(), this.config.sseIntervalMs);
    this.timers.push(loop);

    logger.info('hub', `共享 Token: ${this.config.sharedToken}`);
    logger.info('hub', `Hub「${this.config.name}」启动完成`);
  }

  // ---- 周期任务 ----
  tick() {
    this.fusion.decayNow();
    const ws = this.fusion.worldState();
    const tactics = this.tactics.evaluate(ws);
    const payload = JSON.stringify({ type: 'state', world: ws, tactics });
    for (const client of this.sseClients) {
      client.write(`data: ${payload}\n\n`);
    }
  }

  // ---- 路由 ----
  async route(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    try {
      if (req.method === 'GET' && (p === '/' || p === '/index.html')) return serveFile(res, join(UI_DIR, 'index.html'));
      if (req.method === 'GET' && p === '/api/state') return json(res, 200, { world: this.fusion.worldState(), tactics: this.tactics.evaluate(this.fusion.worldState()) });
      if (req.method === 'GET' && p === '/api/tactics') return json(res, 200, this.tactics.evaluate(this.fusion.worldState()));
      if (req.method === 'GET' && p === '/api/events') return this.sse(res);
      if (req.method === 'GET' && p === '/api/time') return json(res, 200, { now_ms: Date.now() });
      if (req.method === 'GET' && p === '/api/accounts') return json(res, 200, this.listAccounts());
      if (req.method === 'GET' && p === '/api/providers') return json(res, 200, this.fusionProviderList());
      if (req.method === 'POST' && p === '/api/ingest') return this.handleIngest(req, res);
      if (req.method === 'POST' && p === '/api/accounts/login/qr') return this.handleLoginQR(req, res);
      if (req.method === 'POST' && p === '/api/accounts/login/poll') return this.handleLoginPoll(req, res);
      if (req.method === 'POST' && p === '/api/accounts/fetch') return this.handleAccountFetch(req, res);
      if (req.method === 'POST' && p === '/api/accounts/bind') return this.handleAccountBind(req, res);
      return json(res, 404, { error: 'not found' });
    } catch (e) {
      logger.error('hub', `路由异常 ${p}: ${e.message}`);
      return json(res, 500, { error: e.message });
    }
  }

  // 队友上报（0.0.0.0:17889，需共享 Token）
  routeIngest(req, res) {
    if (req.method === 'POST' && (req.url === '/ingest' || req.url === '/api/ingest')) {
      return this.handleIngest(req, res);
    }
    return json(res, 404, { error: 'not found' });
  }

  // ---- ingest ----
  async handleIngest(req, res) {
    const body = await readBody(req);
    const token = req.headers['x-tdf-token'] || body.token || '';
    if (token !== this.config.sharedToken) {
      return json(res, 401, { error: 'invalid token' });
    }
    let list;
    if (Array.isArray(body.observations)) list = body.observations;
    else if (body.observation) list = [body.observation];
    else if (body.type) list = [body];
    else return json(res, 400, { error: 'no observations' });

    const agentId = body.agent_id || 'unknown';
    let n = 0;
    for (const raw of list) {
      const obs = { ...raw };
      if (!obs.observer_id) obs.observer_id = agentId;
      if (!obs.source_instance) obs.source_instance = agentId;
      this.fusion.ingest(obs);
      n++;
    }
    return json(res, 200, { ok: true, ingested: n });
  }

  // ---- SSE ----
  sse(res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
    });
    res.write('retry: 1000\n\n');
    this.sseClients.add(res);
    res.on('close', () => this.sseClients.delete(res));
  }

  // ---- DF 账号 ----
  listAccounts() {
    return Object.keys(this.accounts).map((id) => ({
      id,
      bound: !!this.accounts[id].token,
      profile: this.accountProfiles[id] || null,
    }));
  }

  async handleLoginQR(req, res) {
    const adapter = this._adapter();
    try {
      const qr = await adapter.loginQR();
      return json(res, 200, { ok: true, qr });
    } catch (e) {
      return json(res, 502, { ok: false, error: e.message });
    }
  }

  async handleLoginPoll(req, res) {
    const body = await readBody(req);
    const adapter = this._adapter();
    try {
      const r = await adapter.pollLogin(body.key);
      if (r && r.frameworkToken) {
        const accountId = body.accountId || 'self';
        this.accounts[accountId] = { token: r.frameworkToken };
        this.accountsStore.save(this.accounts);
        this._adapter(accountId).setToken(r.frameworkToken);
      }
      return json(res, 200, { ok: true, result: r });
    } catch (e) {
      return json(res, 502, { ok: false, error: e.message });
    }
  }

  async handleAccountBind(req, res) {
    const body = await readBody(req);
    const accountId = body.accountId || 'self';
    if (body.token) {
      this.accounts[accountId] = { token: body.token };
      this.accountsStore.save(this.accounts);
      this._adapter(accountId).setToken(body.token);
      return json(res, 200, { ok: true });
    }
    return json(res, 400, { ok: false, error: 'missing token' });
  }

  async handleAccountFetch(req, res) {
    const body = await readBody(req);
    const accountId = body.accountId || 'self';
    const adapter = this._adapter(accountId);
    if (!this.accounts[accountId] || !this.accounts[accountId].token) {
      return json(res, 400, { ok: false, error: '账号未绑定' });
    }
    try {
      const profile = await adapter.fetchProfile();
      // 账号/历史数据属于慢元数据（Level C），不进高速融合通道，单独存档
      this.accountProfiles[accountId] = profile;
      return json(res, 200, { ok: true, profile });
    } catch (e) {
      return json(res, 502, { ok: false, error: e.message });
    }
  }

  _adapter(accountId = 'self') {
    if (!this.dfAdapters[accountId]) {
      const a = new DFAccountAdapter({ baseUrl: this.config.dfBaseUrl });
      if (this.accounts[accountId] && this.accounts[accountId].token) a.setToken(this.accounts[accountId].token);
      this.dfAdapters[accountId] = a;
    }
    return this.dfAdapters[accountId];
  }

  fusionProviderList() {
    return [];
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.discovery.stop();
    if (this.server) this.server.close();
    if (this.ingestServer) this.ingestServer.close();
    for (const c of this.sseClients) c.end();
  }
}

// ---- HTTP 工具 ----
function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function serveFile(res, filePath) {
  if (!existsSync(filePath)) {
    res.writeHead(404);
    return res.end('not found');
  }
  const content = readFileSync(filePath);
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(content);
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch { resolve({}); }
    });
  });
}

// ---- 入口 ----
if (process.argv[1] && process.argv[1].endsWith('hub.js')) {
  const hub = new Hub();
  hub.start().catch((e) => {
    logger.error('hub', `启动失败: ${e.message}`);
    process.exit(1);
  });
  process.on('SIGINT', () => { hub.stop(); process.exit(0); });
  process.on('SIGTERM', () => { hub.stop(); process.exit(0); });
}
