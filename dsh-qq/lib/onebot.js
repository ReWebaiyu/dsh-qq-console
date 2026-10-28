/**
 * OneBot 11（NapCat 实现）HTTP 客户端 + 消息归一化。
 *
 * 只依赖 node 内置（global fetch / node:net），不引第三方包，保证插件在任意 profile 里可直接加载。
 * @module dsh-qq/onebot
 */
import net from 'node:net';

/** OneBot 调用失败时抛出的错误，带上 action / retcode 便于排查。 */
export class OneBotError extends Error {
  constructor(message, info = {}) {
    super(message);
    this.name = 'OneBotError';
    this.action = info.action;
    this.retcode = info.retcode;
    this.baseUrl = info.baseUrl;
    this.cause = info.cause;
  }
}

/** 常见 retcode 的中文解释，命中就附在错误后面。 */
const RETCODE_HINTS = {
  100: '参数缺失或格式错误',
  102: '参数不合法（比如 QQ 号 / 群号不是数字）',
  103: '没有找到对应的联系人 / 群（可能不是好友，或号码写错）',
  104: '凭据（token）无效',
  106: '机器人账号不可用',
  1400: '请求参数错误',
  1401: '当前账号权限不足（比如被禁言、不是群成员）',
  1404: '接口不存在或该版本 NapCat 不支持这个 API',
  1403: '权限不足',
  1200: '发送消息失败（可能被风控、不是好友、或消息内容被拒）',
};

/**
 * 轻量 OneBot 11 HTTP 客户端。
 * 每次调用 POST {baseUrl}/{action}，body 为 JSON 参数，凭证走 Authorization: Bearer。
 */
export class OneBotClient {
  constructor({ baseUrl, accessToken, timeoutMs }) {
    this.baseUrl = baseUrl;
    this.accessToken = accessToken || '';
    this.timeoutMs = timeoutMs;
  }

  headers() {
    const headers = { 'content-type': 'application/json', accept: 'application/json' };
    if (this.accessToken !== '') headers.authorization = 'Bearer ' + this.accessToken;
    return headers;
  }

  /**
   * 调一个 OneBot 动作，返回 data 字段。
   * @param {string} action e.g. 'send_private_msg'
   * @param {object} params
   * @param {{timeoutMs?: number}} [options]
   */
  async call(action, params = {}, options = {}) {
    const url = this.baseUrl + '/' + action;
    const timeoutMs = options.timeoutMs || this.timeoutMs;
    const startedAt = Date.now();
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const code = error && (error.code || (error.cause && error.cause.code));
      const reason = error && error.name === 'TimeoutError'
        ? '请求超时（' + timeoutMs + 'ms）'
        : String(code || (error && error.message) || error);
      throw new OneBotError(
        '连不上 OneBot 后端 ' + this.baseUrl + '（' + reason + '）。请确认 NapCat 已启动并登录，且 HTTP 服务端口/地址配置正确。',
        { action, baseUrl: this.baseUrl, cause: reason },
      );
    }

    const latencyMs = Date.now() - startedAt;
    const rawText = await response.text().catch(() => '');
    if (!response.ok) {
      const bodyHint = rawText.slice(0, 200);
      throw new OneBotError(
        'HTTP ' + response.status + ' ' + response.statusText + '：' + this.baseUrl + '/' + action + (bodyHint ? '；响应：' + bodyHint : '') +
          (response.status === 401 || response.status === 403 ? '（token 不匹配？检查 accessToken 配置）' : ''),
        { action, baseUrl: this.baseUrl, retcode: response.status },
      );
    }

    let payload;
    try {
      payload = rawText === '' ? { status: 'ok', retcode: 0, data: null } : JSON.parse(rawText);
    } catch {
      throw new OneBotError('后端返回了非 JSON 内容：' + rawText.slice(0, 200), { action, baseUrl: this.baseUrl });
    }

    const retcode = typeof payload.retcode === 'number' ? payload.retcode : 0;
    const failed = payload.status === 'failed' || retcode !== 0;
    if (failed) {
      const hint = RETCODE_HINTS[retcode] ? '（' + RETCODE_HINTS[retcode] + '）' : '';
      const message = String(payload.message || payload.wording || '未知错误');
      throw new OneBotError(action + ' 失败：retcode=' + retcode + hint + ' ' + message, {
        action,
        baseUrl: this.baseUrl,
        retcode,
      });
    }
    payload.latencyMs = latencyMs;
    return payload;
  }

  /** 调动作但不抛错，返回 {ok, data|error}。用于体检类多路探测。 */
  async probe(action, params = {}, options = {}) {
    try {
      const payload = await this.call(action, params, options);
      return { ok: true, data: payload.data, latencyMs: payload.latencyMs };
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    }
  }
}

/**
 * TCP 探测某端口是否在监听（判断后端进程是否起来）。
 * @param {string} host
 * @param {number} port
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
export function tcpProbe(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    try {
      socket.connect(port, host);
    } catch {
      finish(false);
    }
  });
}

/** 从 baseUrl 里拆出 host / port，给 TCP 探测用。 */
export function hostPortOf(baseUrl) {
  try {
    const url = new URL(baseUrl);
    const host = url.hostname || '127.0.0.1';
    const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
    return { host, port };
  } catch {
    return { host: '127.0.0.1', port: 3000 };
  }
}

function segmentToText(segment) {
  if (typeof segment === 'string') return segment;
  if (!segment || typeof segment !== 'object') return '';
  const type = segment.type;
  const data = segment.data && typeof segment.data === 'object' ? segment.data : {};
  switch (type) {
    case 'text':
      return typeof data.text === 'string' ? data.text : '';
    case 'at':
      return typeof data.qq === 'string' || typeof data.qq === 'number' ? '@' + data.qq + ' ' : '@某人 ';
    case 'image':
      return '[图片' + (data.summary ? ':' + data.summary : '') + ']';
    case 'face':
      return '[表情' + (data.id !== undefined ? ':' + data.id : '') + ']';
    case 'record':
      return '[语音]';
    case 'video':
      return '[视频]';
    case 'file':
      return '[文件' + (data.name ? ':' + data.name : '') + ']';
    case 'reply':
      return '[回复]';
    case 'forward':
      return '[合并转发]';
    case 'json':
    case 'xml':
      return '[卡片消息]';
    default:
      return data.text ? String(data.text) : '[' + String(type) + ']';
  }
}

/**
 * 把 OneBot 消息（字符串或 segment 数组）压成一行纯文本，方便模型阅读。
 * @param {unknown} message
 */
export function messageToText(message) {
  if (message === null || message === undefined) return '';
  if (typeof message === 'string') return message;
  if (Array.isArray(message)) return message.map(segmentToText).join('').trim();
  if (typeof message === 'object' && Array.isArray(message.message)) return messageToText(message.message);
  return String(message);
}

function formatTimestamp(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return '';
  const date = new Date(n * 1000);
  const pad = (v) => String(v).padStart(2, '0');
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
}

/**
 * 归一化一条历史消息。
 * @param {Record<string, unknown>} raw
 */
export function normalizeHistoryMessage(raw) {
  const message = raw && typeof raw === 'object' ? raw : {};
  const sender = message.sender && typeof message.sender === 'object' ? message.sender : {};
  const text = messageToText(message.message) || (typeof message.raw_message === 'string' ? message.raw_message : '');
  return {
    messageId: message.message_id ?? message.messageId ?? null,
    time: formatTimestamp(message.time),
    timestamp: typeof message.time === 'number' ? message.time : null,
    senderId: sender.user_id ?? message.user_id ?? null,
    senderName: sender.card || sender.nickname || (sender.user_id !== undefined ? String(sender.user_id) : ''),
    groupId: message.group_id ?? null,
    text,
    raw: typeof message.raw_message === 'string' ? message.raw_message : null,
  };
}

/** 从历史接口响应里掏出 messages 数组（兼容 data.messages / data 为数组两种形状）。 */
export function extractMessages(payloadData) {
  if (Array.isArray(payloadData)) return payloadData;
  if (payloadData && typeof payloadData === 'object') {
    if (Array.isArray(payloadData.messages)) return payloadData.messages;
    if (Array.isArray(payloadData.message)) return payloadData.message;
  }
  return [];
}
