// DF Account Adapter（《原理》第三节：三角洲社区 API 账号/历史数据链）。
// 扫码登录 → frameworkToken → REST 拉取资料/战绩/地图/资产/经济/物品。
// 说明：社区后端地址与鉴权头由配置指定（第三方维护，非腾讯官方 SDK）。

import { logger } from '../util.js';
import { wallMs } from '../core/clock.js';

const DEFAULT_PATHS = {
  qrLogin: '/login/qq/qr',
  qrStatus: '/login/qq/status',
  personalInfo: '/df/person/personalinfo',
  personalData: '/df/person/PersonalData',
  record: '/df/person/record',
  dailyRecord: '/df/person/dailyRecord',
  weeklyRecord: '/df/person/weeklyRecord',
  mapStats: '/df/person/mapStats',
  collection: '/df/person/collection',
  money: '/df/person/money',
  flows: '/df/person/flows',
  friendInfo: '/df/person/friendinfo',
  placeStatus: '/df/place/status',
  items: '/df/objects/items',
  price: '/df/objects/price',
};

export class DFAccountAdapter {
  constructor({ baseUrl, authHeader = 'frameworkToken', timeoutMs = 8000 } = {}) {
    this.baseUrl = (baseUrl || '').replace(/\/$/, '');
    this.authHeader = authHeader;
    this.timeoutMs = timeoutMs;
    this.frameworkToken = null;
  }

  setToken(token) {
    this.frameworkToken = token;
  }

  // ---- 登录 ----
  async loginQR() {
    const j = await this._request(this.baseUrl + DEFAULT_PATHS.qrLogin, {});
    return j;
  }

  async pollLogin(key) {
    const url = this.baseUrl + DEFAULT_PATHS.qrStatus + (key ? `?key=${encodeURIComponent(key)}` : '');
    const j = await this._request(url, {});
    if (j && j.frameworkToken) {
      this.frameworkToken = j.frameworkToken;
    }
    return j;
  }

  // ---- 资料/战绩 ----
  async personalInfo() { return this._get(DEFAULT_PATHS.personalInfo); }
  async personalData() { return this._get(DEFAULT_PATHS.personalData); }
  async record() { return this._get(DEFAULT_PATHS.record); }
  async dailyRecord() { return this._get(DEFAULT_PATHS.dailyRecord); }
  async weeklyRecord() { return this._get(DEFAULT_PATHS.weeklyRecord); }
  async mapStats() { return this._get(DEFAULT_PATHS.mapStats); }
  async collection() { return this._get(DEFAULT_PATHS.collection); }
  async money() { return this._get(DEFAULT_PATHS.money); }
  async flows() { return this._get(DEFAULT_PATHS.flows); }
  async friendInfo() { return this._get(DEFAULT_PATHS.friendInfo); }
  async placeStatus() { return this._get(DEFAULT_PATHS.placeStatus); }
  async items() { return this._get(DEFAULT_PATHS.items); }
  async price() { return this._get(DEFAULT_PATHS.price); }

  // 一次拉全量，转成 ACCOUNT 慢元数据 Observation（不进入高速通道）
  async fetchProfile() {
    const [personalInfo, personalData, record, mapStats, money, collection] = await Promise.allSettled([
      this.personalInfo(), this.personalData(), this.record(), this.mapStats(), this.money(), this.collection(),
    ]);
    const pick = (p) => (p.status === 'fulfilled' ? p.value : null);
    return {
      personalInfo: pick(personalInfo),
      personalData: pick(personalData),
      record: pick(record),
      mapStats: pick(mapStats),
      money: pick(money),
      collection: pick(collection),
    };
  }

  toObservation(profile, accountId = 'self') {
    return {
      type: 'ACCOUNT',
      subject: { kind: 'SELF', id: accountId },
      source: 'OFFICIAL_API',
      confidence: 1.0,
      account: profile,
      timestamp_wall_ms: wallMs(),
    };
  }

  async _get(path) {
    return this._request(this.baseUrl + path, {});
  }

  async _request(url, opts) {
    if (!this.baseUrl) {
      throw new Error('DF Account Adapter baseUrl 未配置（需要指向可用的社区后端实例）');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers = { accept: 'application/json', ...(opts.headers || {}) };
    if (this.frameworkToken) headers[this.authHeader] = this.frameworkToken;
    try {
      const res = await fetch(url, {
        method: opts.method || 'GET',
        headers,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        return { raw: text };
      }
    } catch (e) {
      logger.warn('dfapi', `请求失败 ${url}: ${e.message}`);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}
