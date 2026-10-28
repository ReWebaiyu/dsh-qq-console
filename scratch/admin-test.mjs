// 离线自检：用假的 engine/store 把面板跑起来，检查 HTML 与各 API 是否正常。
import { createAdminServer } from '../dsh-qq/lib/admin.js';
import { createStore } from '../dsh-qq/lib/store.js';
import { resolveConfig } from '../dsh-qq/lib/config.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cfg = resolveConfig({ baseUrl: 'http://127.0.0.1:3998', adminPort: 3099, eventPort: 3997, qrcodePath: 'D:\\WenJian\\NapCat\\cache\\qrcode.png' });
const store = createStore({ dir: mkdtempSync(join(tmpdir(), 'qq-admin-')) });
store.applyTo(cfg);
store.addUsage({ model: 'deepseek-account/deepseek-flash', inputTokens: 1200, outputTokens: 90 });

const engine = {
  state: { enabled: true, replies: 3, skips: 7, lastReplyAt: '13:20:00', lastError: null },
  status: () => ({
    enabled: true,
    replies: 3,
    skips: 7,
    cooldownSec: cfg.cooldownSec,
    limits: { perGroupPerHour: 8, totalPerHour: 30 },
    lastReplyAt: '13:20:00',
    lastError: null,
    decisions: [{ at: '13:20:00', kind: 'mention', sender: '小明', text: '@ 在吗', reply: '在啊，咋了', model: 'deepseek-account/deepseek-flash' }],
  }),
  setEnabled: (value) => value,
  simulate: async ({ text }) => ({ reply: '收到：' + text, delayMs: 900 }),
};
const eventServer = { state: { listening: true, received: 12, accepted: 12, rejected: 0, port: cfg.eventPort, host: '127.0.0.1' } };
const napcat = { hasToken: false, loginStatus: async () => ({ isLogin: false, loginPhase: 'offline', qrcodeUrl: '', loginError: '' }), loginInfo: async () => ({}) };

const admin = createAdminServer({ cfg, store, engine, eventServer, napcat, log: (line) => console.log('[log]', line) });
await new Promise((r) => setTimeout(r, 400));

const base = 'http://127.0.0.1:3099';
const get = async (path) => {
  const response = await fetch(base + path);
  const text = await response.text();
  return { status: response.status, type: response.headers.get('content-type'), length: text.length, text };
};
const post = async (path, body) => {
  const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
};

const page = await get('/');
console.log('GET / →', page.status, page.type, page.length, 'bytes; 有表格标题:', page.text.includes('QQ Console'));

const state = await get('/api/state');
const parsed = JSON.parse(state.text);
console.log('GET /api/state →', state.status, JSON.stringify({ account: parsed.account.loggedIn, replies: parsed.bot.replies, groups: parsed.settings.groups, tokens: parsed.usage.today.inputTokens }));

const saved = await post('/api/settings', { persona: '你说话像二次元', groups: ['1017271626'], watchUsers: ['10001'], chatChance: 0.3, bogusKey: 1 });
console.log('POST /api/settings →', saved.status, JSON.stringify({ persona: saved.body.settings.persona.slice(0, 8), groups: saved.body.settings.groups, users: saved.body.settings.watchUsers, chance: saved.body.settings.chatChance, refused: saved.body.refused }));

const tested = await post('/api/test', { text: '在吗' });
console.log('POST /api/test →', tested.status, JSON.stringify(tested.body));

const qr = await post('/api/login/qrcode', {});
console.log('POST /api/login/qrcode →', qr.status, JSON.stringify(qr.body));

const missing = await get('/api/login/qr.png');
console.log('GET /api/login/qr.png（有图时 200 / 无图 404）→', missing.status);

console.log('store file:', store.file, '内容里含 persona:', JSON.parse((await import('node:fs')).readFileSync(store.file, 'utf8')).settings.persona);
await admin.close();
