/**
 * 配置解析：所有字段都有缺省值，缺省值对应本机实测可用的 NapCat 部署。
 * 配置文件来源是组合包补丁（cordis.patch.yml）里的 config 块，或用户 profile 的同 id 覆盖行。
 * @module dsh-qq/config
 */

function asRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
}

function pickString(raw, key, fallback) {
  const value = raw[key];
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return fallback;
}

function pickNumber(raw, key, fallback, min, max) {
  const value = raw[key];
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function pickBoolean(raw, key, fallback) {
  const value = raw[key];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
  }
  return fallback;
}

function pickList(raw, key, fallback) {
  const value = raw[key];
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter((item) => item !== '');
  if (typeof value === 'string' && value.trim() !== '') {
    return value
      .split(/[,，\s]+/)
      .map((item) => item.trim())
      .filter((item) => item !== '');
  }
  return fallback.slice();
}

/** 缺省配置（本机 NapCat 默认 HTTP 端口 3000，事件推送端口 3010）。 */
export const DEFAULTS = Object.freeze({
  baseUrl: 'http://127.0.0.1:3000',
  accessToken: '',
  timeoutMs: 15000,
  launcherPath: 'D:\\WenJian\\NapCat\\launcher.bat',
  startTimeoutMs: 120000,
  // 自动回复
  autoReply: true,
  panelEnabled: true,
  groups: ['1017271626'],
  aliases: ['小白', '机器人', '小助手'],
  chatChance: 0.15,
  cooldownSec: 25,
  maxPerHourGroup: 8,
  maxPerHourTotal: 30,
  maxReplyChars: 80,
  contextSize: 14,
  persona: '',
  provider: '',
  model: '',
  // 事件推送（NapCat httpClients → 本插件）
  eventPort: 3012,
  eventToken: '',
  // 白名单：只理会这些 QQ 号（空 = 所有人）
  watchUsers: [],
  // 网页面板 / NapCat 管理端 / 数据目录
  adminPort: 3014,
  napcatWebuiUrl: 'http://127.0.0.1:6099',
  napcatWebuiConfig: 'D:\\WenJian\\NapCat\\config\\webui.json',
  qrcodePath: 'D:\\WenJian\\NapCat\\cache\\qrcode.png',
  loginAccount: '1766131793',
  dataDir: '',
});

/**
 * 规范化 baseUrl：补 http://、去掉末尾斜杠和多余的 /api 后缀。
 * @param {string} value
 */
export function normalizeBaseUrl(value) {
  let url = String(value || '').trim();
  if (url === '') url = DEFAULTS.baseUrl;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = 'http://' + url;
  url = url.replace(/\/+$/, '');
  url = url.replace(/\/api$/i, '');
  return url;
}

/**
 * 解析插件配置。
 * @param {unknown} raw 组合包补丁里的 config
 */
export function resolveConfig(raw) {
  const source = asRecord(raw);
  const accessToken = typeof source.accessToken === 'string' ? source.accessToken.trim() : DEFAULTS.accessToken;
  const eventToken = typeof source.eventToken === 'string' ? source.eventToken.trim() : accessToken;
  return {
    baseUrl: normalizeBaseUrl(pickString(source, 'baseUrl', DEFAULTS.baseUrl)),
    accessToken,
    timeoutMs: pickNumber(source, 'timeoutMs', DEFAULTS.timeoutMs, 1000, 120000),
    launcherPath: pickString(source, 'launcherPath', DEFAULTS.launcherPath),
    startTimeoutMs: pickNumber(source, 'startTimeoutMs', DEFAULTS.startTimeoutMs, 5000, 600000),
    autoReply: pickBoolean(source, 'autoReply', DEFAULTS.autoReply),
    panelEnabled: pickBoolean(source, 'panelEnabled', DEFAULTS.panelEnabled),
    groups: pickList(source, 'groups', DEFAULTS.groups),
    aliases: pickList(source, 'aliases', DEFAULTS.aliases),
    chatChance: pickNumber(source, 'chatChance', DEFAULTS.chatChance, 0, 1),
    cooldownSec: pickNumber(source, 'cooldownSec', DEFAULTS.cooldownSec, 3, 3600),
    maxPerHourGroup: pickNumber(source, 'maxPerHourGroup', DEFAULTS.maxPerHourGroup, 1, 200),
    maxPerHourTotal: pickNumber(source, 'maxPerHourTotal', DEFAULTS.maxPerHourTotal, 1, 500),
    maxReplyChars: pickNumber(source, 'maxReplyChars', DEFAULTS.maxReplyChars, 10, 400),
    contextSize: pickNumber(source, 'contextSize', DEFAULTS.contextSize, 4, 60),
    persona: typeof source.persona === 'string' ? source.persona : DEFAULTS.persona,
    provider: pickString(source, 'provider', DEFAULTS.provider),
    model: pickString(source, 'model', DEFAULTS.model),
    eventPort: pickNumber(source, 'eventPort', DEFAULTS.eventPort, 1024, 65535),
    eventToken,
    watchUsers: pickList(source, 'watchUsers', DEFAULTS.watchUsers),
    adminPort: pickNumber(source, 'adminPort', DEFAULTS.adminPort, 1024, 65535),
    napcatWebuiUrl: pickString(source, 'napcatWebuiUrl', DEFAULTS.napcatWebuiUrl),
    napcatWebuiConfig: pickString(source, 'napcatWebuiConfig', DEFAULTS.napcatWebuiConfig),
    qrcodePath: pickString(source, 'qrcodePath', DEFAULTS.qrcodePath),
    loginAccount: pickString(source, 'loginAccount', DEFAULTS.loginAccount),
    dataDir: typeof source.dataDir === 'string' ? source.dataDir.trim() : DEFAULTS.dataDir,
  };
}
