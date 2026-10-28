/**
 * 网页面板：http://127.0.0.1:<adminPort>/
 *
 * 只监听本机回环地址；提供页面 + 一组 JSON API（状态 / 改设置 / 自测 / 登录二维码 / 启动后端）。
 * 不含任何第三方依赖：HTTP 用 node:http，页面是 lib/admin-ui.html。
 *
 * 这个服务在每个进程里只创建一次（挂在 globalThis 上由 index.js 复用），
 * 每个请求通过 getContext() 取当前的 cfg/store/engine，所以插件热重载后不会拿到旧对象。
 * @module dsh-qq/admin
 */
import http from 'node:http';
import net from 'node:net';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { OneBotClient } from './onebot.js';
import { startLauncherAndWait } from './backend.js';

const UI_PATH = fileURLToPath(new URL('./admin-ui.html', import.meta.url));

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (text === '') return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function probePort(baseUrl) {
  return new Promise((resolve) => {
    try {
      const url = new URL(String(baseUrl));
      const host = url.hostname || '127.0.0.1';
      const port = url.port ? Number(url.port) : 80;
      const socket = new net.Socket();
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        socket.destroy();
        resolve(value);
      };
      socket.setTimeout(900);
      socket.once('connect', () => finish(true));
      socket.once('timeout', () => finish(false));
      socket.once('error', () => finish(false));
      socket.connect(port, host);
    } catch {
      resolve(false);
    }
  });
}

/**
 * @param {{getContext: () => {cfg: any, store: any, engine: any, eventServer: any, napcat: any}, log?: (line: string) => void}} options
 */
export function createAdminServer({ getContext, log }) {
  const state = { listening: false, port: 0, startedAt: Date.now(), lastError: null };
  const cache = { account: null, accountAt: 0, version: '', clientKey: '' };

  function clientFor(cfg) {
    const key = cfg.baseUrl + '|' + cfg.accessToken;
    if (cache.clientKey !== key) {
      cache.client = new OneBotClient({ baseUrl: cfg.baseUrl, accessToken: cfg.accessToken, timeoutMs: 6000 });
      cache.clientKey = key;
      cache.account = null;
      cache.accountAt = 0;
    }
    return cache.client;
  }

  async function accountSnapshot({ cfg, napcat }) {
    const now = Date.now();
    if (cache.account && now - cache.accountAt < 8000) return cache.account;
    const client = clientFor(cfg);
    let reachable = false;
    let loggedIn = false;
    let uin = '';
    let nick = '';
    let phase = '';
    let online = false;
    let loginError = '';

    const loginProbe = await client.probe('get_login_info');
    if (loginProbe.ok) {
      reachable = true;
      const info = loginProbe.data && typeof loginProbe.data === 'object' ? loginProbe.data : {};
      uin = info.user_id !== undefined ? String(info.user_id) : '';
      nick = typeof info.nickname === 'string' ? info.nickname : '';
      loggedIn = uin !== '';
      online = loggedIn;
    }
    if (cache.version === '') {
      const versionProbe = await client.probe('get_version_info');
      if (versionProbe.ok && versionProbe.data && typeof versionProbe.data === 'object') {
        cache.version = String(versionProbe.data.app_version || versionProbe.data.app_name || '');
      }
    }
    if (napcat && napcat.hasToken) {
      try {
        const status = await napcat.loginStatus();
        reachable = reachable || status.coreReady || status.isLogin;
        phase = status.loginPhase;
        loginError = status.loginError;
        if (status.isLogin) {
          loggedIn = true;
          const info = await napcat.loginInfo().catch(() => null);
          if (info) {
            uin = info.uin || uin;
            nick = info.nick || nick;
            online = info.online;
          }
        }
      } catch (error) {
        if (loginError === '') loginError = String((error && error.message) || error);
      }
    }
    if (!reachable) reachable = await probePort(cfg.baseUrl);
    const snapshot = { reachable, backendReachable: reachable, loggedIn, uin, nick, phase, online, loginError };
    cache.account = snapshot;
    cache.accountAt = now;
    return snapshot;
  }

  function settingsView(cfg) {
    return {
      persona: typeof cfg.persona === 'string' ? cfg.persona : '',
      groups: Array.isArray(cfg.groups) ? cfg.groups : [],
      watchUsers: Array.isArray(cfg.watchUsers) ? cfg.watchUsers : [],
      aliases: Array.isArray(cfg.aliases) ? cfg.aliases : [],
      autoReply: cfg.autoReply !== false,
      panelEnabled: cfg.panelEnabled !== false,
      chatChance: Number(cfg.chatChance || 0),
      cooldownSec: Number(cfg.cooldownSec || 0),
      maxPerHourGroup: Number(cfg.maxPerHourGroup || 0),
      maxPerHourTotal: Number(cfg.maxPerHourTotal || 0),
      maxReplyChars: Number(cfg.maxReplyChars || 0),
      contextSize: Number(cfg.contextSize || 0),
    };
  }

  /**
   * 处理一次面板请求。basePath 是挂载前缀：
   *   '' = 独立端口 3014 根路径；'/qq-panel' = 挂在 DSH Web 服务上（侧边框 iframe 用，同源免 CORS）。
   */
  async function handleRequest(req, res, basePath) {
    const remote = req.socket.remoteAddress || '';
    if (!(remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1')) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const prefix = typeof basePath === 'string' ? basePath.replace(/\/+$/, '') : '';
    const url = new URL('http://localhost' + (req.url || '/'));
    let path = url.pathname;
    if (prefix !== '' && path.startsWith(prefix)) path = path.slice(prefix.length);
    path = path.replace(/\/+$/, '') || '/';
    const context = getContext() || {};

    try {
      if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
        const html = readFileSync(UI_PATH, 'utf8').replace('__API_BASE__', prefix);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', 'content-length': Buffer.byteLength(html) });
        res.end(html);
        return;
      }

      if (req.method === 'GET' && path === '/api/state') {
        const cfg = context.cfg || {};
        const account = await accountSnapshot({ cfg, napcat: context.napcat });
        const bot = context.engine ? context.engine.status() : { enabled: false, decisions: [], replies: 0, skips: 0 };
        const lastDecision = bot.decisions && bot.decisions[0];
        sendJson(res, 200, {
          account,
          bot,
          event: context.eventServer ? context.eventServer.state : null,
          settings: settingsView(cfg),
          usage: context.store ? context.store.usageSummary() : { today: {}, days: [], week: {} },
          model: { label: lastDecision && lastDecision.model ? lastDecision.model : cfg.model || '(跟随 DSH 默认)' },
          version: cache.version,
          dataFile: context.store ? context.store.file : '',
          now: Date.now(),
        });
        return;
      }

      if (req.method === 'POST' && path === '/api/settings') {
        const body = await readBody(req);
        const cfg = context.cfg || {};
        const result = context.store.savePatch(body, cfg);
        if (Object.prototype.hasOwnProperty.call(result.patch, 'autoReply') && context.engine) context.engine.setEnabled(result.patch.autoReply);
        sendJson(res, 200, { ok: true, settings: settingsView(cfg), refused: result.rejected });
        return;
      }

      if (req.method === 'POST' && path === '/api/bot') {
        const body = await readBody(req);
        const enabled = context.engine ? context.engine.setEnabled(body.enabled === true) : false;
        if (context.store && context.cfg) context.store.savePatch({ autoReply: enabled }, context.cfg);
        sendJson(res, 200, { ok: true, enabled });
        return;
      }

      if (req.method === 'POST' && path === '/api/test') {
        const body = await readBody(req);
        const text = typeof body.text === 'string' ? body.text.trim() : '';
        if (text === '') return sendJson(res, 400, { error: 'text 不能为空' });
        if (!context.engine) return sendJson(res, 503, { error: '引擎未就绪' });
        const result = await context.engine.simulate({ text, senderName: '群友', send: false });
        return sendJson(res, 200, { ok: true, reply: result.reply || '', delayMs: result.delayMs || 0, error: result.error || result.skipped || null });
      }

      if (req.method === 'GET' && path === '/api/login/status') {
        const account = await accountSnapshot({ cfg: context.cfg || {}, napcat: context.napcat });
        return sendJson(res, 200, { loggedIn: account.loggedIn, phase: account.phase, uin: account.uin, nick: account.nick, error: account.loginError });
      }

      if (req.method === 'POST' && path === '/api/login/qrcode') {
        const cfg = context.cfg || {};
        const account = await accountSnapshot({ cfg, napcat: context.napcat });
        if (account.loggedIn) return sendJson(res, 200, { ok: true, loggedIn: true });
        if (!context.napcat || !context.napcat.hasToken) {
          return sendJson(res, 400, { error: '没读到 NapCat WebUI token（napcatWebuiConfig 指向 config/webui.json）' });
        }
        const qrPath = String(cfg.qrcodePath || '');
        const before = existsSync(qrPath) ? statSync(qrPath).mtimeMs : 0;
        let lastError = '';
        // NapCat 刚启动时 WebUI 可能还没就绪，重试几次再放弃。
        for (let attempt = 0; attempt < 4; attempt += 1) {
          try {
            const result = await context.napcat.qrcode();
            await new Promise((resolve) => setTimeout(resolve, 800));
            const fresh = existsSync(qrPath) && statSync(qrPath).mtimeMs > before;
            if (fresh || existsSync(qrPath)) {
              return sendJson(res, 200, { ok: true, qrcodeUrl: result.qrcodeUrl, imageReady: true, fresh });
            }
            lastError = 'NapCat 返回了二维码链接，但没写出 qrcode.png';
          } catch (error) {
            lastError = String((error && error.message) || error);
            if (/Is Logined|已登录/i.test(lastError)) break;
          }
          await new Promise((resolve) => setTimeout(resolve, 1200));
        }
        return sendJson(res, 200, {
          ok: false,
          error: lastError,
          imageReady: existsSync(qrPath),
          hint: /fetch|ECONNREFUSED|连不上/i.test(lastError)
            ? 'NapCat 管理端（127.0.0.1:6099）还没起来：等后端启动完成，或直接看 NapCat 控制台窗口里的二维码。'
            : '生成二维码失败：可以点「刷新二维码」重试，或看 NapCat 控制台窗口里的二维码。',
        });
      }

      if (req.method === 'GET' && path === '/api/login/qr.png') {
        const qrPath = String((context.cfg && context.cfg.qrcodePath) || '');
        if (!qrPath || !existsSync(qrPath)) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('二维码还没生成');
          return;
        }
        const bytes = readFileSync(qrPath);
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store', 'content-length': bytes.length, 'last-modified': statSync(qrPath).mtime.toUTCString() });
        res.end(bytes);
        return;
      }

      if (req.method === 'POST' && path === '/api/backend/start') {
        const cfg = context.cfg || {};
        const result = await startLauncherAndWait(
          {
            launcherPath: String(cfg.launcherPath || ''),
            account: String(cfg.loginAccount || ''),
            baseUrl: String(cfg.baseUrl || 'http://127.0.0.1:3000'),
            timeoutMs: 45000,
          },
          probePort,
        );
        return sendJson(res, 200, {
          ok: result.ok,
          started: result.started,
          portOpen: result.portOpen === true,
          waitedMs: result.waitedMs || 0,
          reason: result.reason || null,
        });
      }

      sendJson(res, 404, { error: 'not found' });
    } catch (error) {
      state.lastError = String((error && error.message) || error);
      if (log) log('面板请求出错：' + state.lastError);
      if (!res.writableEnded) sendJson(res, 500, { error: state.lastError });
    }
  }

  const server = http.createServer((req, res) => {
    void handleRequest(req, res, '');
  });

  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  server.on('error', (error) => {
    state.listening = false;
    state.lastError = '面板端口监听失败：' + (error && error.message ? error.message : String(error));
    if (log) log(state.lastError);
  });

  return {
    state,
    /** 给 DSH Web 服务挂载用（同源，侧边框 iframe 走这里）。 */
    handle(req, res, basePath) {
      return handleRequest(req, res, basePath);
    },
    start(port) {
      state.port = port;
      let attempts = 0;
      const bind = () => {
        server.listen(port, '127.0.0.1', () => {
          state.listening = true;
          state.lastError = null;
          if (log) log('网页面板：http://127.0.0.1:' + port + '/');
        });
        server.once('error', (error) => {
          if (error && error.code === 'EADDRINUSE' && attempts < 20) {
            attempts += 1;
            setTimeout(bind, 700);
          }
        });
      };
      bind();
    },
    close() {
      for (const socket of sockets) {
        try {
          socket.destroy();
        } catch {
          /* ignore */
        }
      }
      sockets.clear();
      return new Promise((resolve) => {
        try {
          server.closeAllConnections?.();
        } catch {
          /* ignore */
        }
        try {
          server.close(() => resolve());
        } catch {
          resolve();
        }
      });
    },
  };
}
