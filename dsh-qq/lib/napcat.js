/**
 * NapCat WebUI（管理端）客户端：登录凭证、登录状态、二维码、快速登录列表。
 *
 * WebUI 的认证是两步的：
 *   1. POST /api/auth/login  body { hash: sha256(webuiToken + '.napcat') } → { data: { Credential } }
 *   2. 之后所有请求带 Authorization: Bearer <Credential>（有效期 1 小时）
 * 凭证过期就重新登录一次。
 * @module dsh-qq/napcat
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

/**
 * 从 NapCat 的 webui.json 里读 WebUI token（读不到返回空串）。
 * @param {string} configPath
 */
export function readWebuiToken(configPath) {
  try {
    if (!configPath || !existsSync(configPath)) return '';
    const parsed = JSON.parse(readFileSync(configPath, 'utf8'));
    return typeof parsed.token === 'string' ? parsed.token.trim() : '';
  } catch {
    return '';
  }
}

/** 计算 WebUI 登录用的 hash。 */
export function webuiHash(token) {
  return createHash('sha256').update(String(token) + '.napcat').digest('hex');
}

/**
 * @param {{baseUrl: string, token: string, timeoutMs?: number}} options
 */
export function createNapcatWebui({ baseUrl, token, timeoutMs = 8000 }) {
  const root = String(baseUrl || 'http://127.0.0.1:6099').replace(/\/+$/, '');
  let credential = '';
  let credentialAt = 0;

  async function postRaw(path, body, header) {
    const response = await fetch(root + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(header ? { authorization: 'Bearer ' + header } : {}) },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let payload = {};
    try {
      payload = text === '' ? {} : JSON.parse(text);
    } catch {
      payload = { code: -1, message: 'WebUI 返回非 JSON：' + text.slice(0, 120) };
    }
    return { status: response.status, payload };
  }

  async function ensureCredential(force = false) {
    if (token === '') throw new Error('没读到 NapCat 的 WebUI token（检查 napcatWebuiConfig 指向的 config/webui.json）');
    if (!force && credential !== '' && Date.now() - credentialAt < 50 * 60 * 1000) return credential;
    const { payload } = await postRaw('/api/auth/login', { hash: webuiHash(token) });
    const data = payload && typeof payload === 'object' ? payload.data : null;
    if (!data || typeof data.Credential !== 'string') {
      throw new Error('WebUI 登录失败：' + String((payload && payload.message) || '未知错误'));
    }
    credential = data.Credential;
    credentialAt = Date.now();
    return credential;
  }

  async function call(path, body) {
    await ensureCredential();
    let result = await postRaw(path, body, credential);
    if (result.payload && result.payload.message === 'Unauthorized') {
      await ensureCredential(true);
      result = await postRaw(path, body, credential);
    }
    if (result.payload && typeof result.payload === 'object' && result.payload.code !== 0) {
      throw new Error(String(result.payload.message || 'WebUI 接口失败'));
    }
    return result.payload ? result.payload.data : null;
  }

  return {
    root,
    hasToken: token !== '',
    /** 登录状态 / 阶段 / 二维码 URL / 错误。 */
    async loginStatus() {
      const data = await call('/api/QQLogin/CheckLoginStatus');
      const record = data && typeof data === 'object' ? data : {};
      return {
        isLogin: record.isLogin === true,
        isOffline: record.isOffline === true,
        loginPhase: String(record.loginPhase || ''),
        qrcodeUrl: String(record.qrcodeurl || ''),
        loginError: String(record.loginError || ''),
        coreReady: record.coreReady === true,
      };
    },
    /** 已登录账号信息（未登录时 NapCat 会给错误）。 */
    async loginInfo() {
      const data = await call('/api/QQLogin/GetQQLoginInfo');
      const record = data && typeof data === 'object' ? data : {};
      return {
        uid: String(record.uid || ''),
        uin: record.uin !== undefined ? String(record.uin) : '',
        nick: String(record.nick || ''),
        online: record.online !== false,
      };
    },
    /** 拉取新二维码（未登录时；返回 { qrcodeurl }）。 */
    async qrcode() {
      const data = await call('/api/QQLogin/GetQQLoginQrcode');
      const record = data && typeof data === 'object' ? data : {};
      return { qrcodeUrl: String(record.qrcodeurl || record.qrcodeUrl || '') };
    },
    /** 快速登录账号列表（字符串形式的号或列表）。 */
    async quickLoginList() {
      const data = await call('/api/QQLogin/GetQuickLoginQQ');
      if (Array.isArray(data)) return data.map((item) => String(item));
      if (typeof data === 'string' && data.trim() !== '') return data.split(/[,，\s]+/).filter(Boolean);
      return [];
    },
  };
}
