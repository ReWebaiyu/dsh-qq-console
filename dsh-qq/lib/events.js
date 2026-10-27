/**
 * 收 NapCat 的事件推送（OneBot 11 HTTP POST 上报）。
 *
 * 只做传输与去重：验证 token/来源、解析 JSON、过滤出群消息，其余交给 engine。
 * 用 node:http，不引第三方依赖。
 * @module dsh-qq/events
 */
import http from 'node:http';

/**
 * @param {{
 *   port: number,
 *   host?: string,
 *   token?: string,
 *   onEvent: (event: Record<string, unknown>) => void,
 *   onLog?: (line: string) => void,
 * }} options
 */
export function createEventServer(options) {
  const host = options.host || '127.0.0.1';
  let token = String(options.token || '');
  const currentToken = () => (typeof options.getToken === 'function' ? String(options.getToken() || '') : token);
  const seen = new Set();
  const state = {
    listening: false,
    port: options.port,
    host,
    received: 0,
    accepted: 0,
    rejected: 0,
    lastError: null,
    lastRejection: null,
    lastEventAt: null,
    startedAt: Date.now(),
  };

  const server = http.createServer((req, res) => {
    const note = (reason, status) => {
      state.rejected += 1;
      state.lastRejection = {
        at: Date.now(),
        reason,
        status,
        method: req.method,
        path: req.url,
        remote: req.socket.remoteAddress || '',
        authorization: String(req.headers.authorization || '').slice(0, 12) + (String(req.headers.authorization || '').length > 12 ? '…' : ''),
        contentType: String(req.headers['content-type'] || ''),
      };
      if (options.onLog) options.onLog('事件被拒（' + reason + '）：' + req.method + ' ' + req.url + ' from ' + (req.socket.remoteAddress || '?'));
    };
    if (req.method !== 'POST') {
      note('method', 405);
      res.writeHead(405, { 'content-type': 'text/plain' });
      res.end('method not allowed');
      return;
    }
    const remote = req.socket.remoteAddress || '';
    if (!(remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1')) {
      note('remote', 403);
      res.writeHead(403).end('forbidden');
      return;
    }
    if (currentToken() !== '') {
      const authorization = String(req.headers.authorization || '');
      const headerToken = authorization.replace(/^Bearer\s+/i, '').trim();
      let query = {};
      try {
        query = new URL('http://localhost' + (req.url || '/')).searchParams;
      } catch {
        query = { get: () => null };
      }
      const provided = headerToken || String(query.get('access_token') || query.get('token') || '').trim();
      if (provided !== currentToken()) {
        note('token', 401);
        res.writeHead(401).end('unauthorized');
        return;
      }
    }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) {
        res.writeHead(413).end('too large');
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      state.received += 1;
      state.lastEventAt = Date.now();
      let event;
      try {
        event = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch (error) {
        state.lastError = '事件不是合法 JSON：' + (error && error.message ? error.message : String(error));
        res.writeHead(400).end('bad json');
        return;
      }
      // OneBot 11 心跳等元事件直接放过，不占去重表。
      if (event && event.post_type === 'meta_event') {
        res.writeHead(204).end();
        return;
      }
      const key = event && event.message_id !== undefined ? 'm' + event.message_id : '';
      if (key !== '') {
        if (seen.has(key)) {
          res.writeHead(204).end();
          return;
        }
        seen.add(key);
        if (seen.size > 800) {
          const drop = seen.size - 600;
          let index = 0;
          for (const value of seen) {
            seen.delete(value);
            if (++index >= drop) break;
          }
        }
      }
      state.accepted += 1;
      res.writeHead(204).end();
      try {
        options.onEvent(event);
      } catch (error) {
        state.lastError = '处理事件出错：' + (error && error.message ? error.message : String(error));
        if (options.onLog) options.onLog(state.lastError);
      }
    });
  });

  // 插件热重载时旧实例的端口可能还没释放，绑定要能重试。
  let listenAttempts = 0;
  const bind = () => {
    try {
      server.listen(options.port, host, () => {
        state.listening = true;
        state.lastError = null;
        if (options.onLog) options.onLog('事件端口已监听 http://' + host + ':' + options.port + '/');
      });
    } catch (error) {
      state.lastError = '事件端口监听失败：' + (error && error.message ? error.message : String(error));
      if (options.onLog) options.onLog(state.lastError);
    }
  };

  server.on('error', (error) => {
    const code = error && error.code;
    if (code === 'EADDRINUSE' && listenAttempts < 20) {
      listenAttempts += 1;
      state.listening = false;
      state.lastError = '端口 ' + options.port + ' 被占用，第 ' + listenAttempts + ' 次重试绑定…';
      if (options.onLog) options.onLog(state.lastError);
      setTimeout(bind, 700);
      return;
    }
    state.listening = false;
    state.lastError = '事件端口监听失败：' + (error && error.message ? error.message : String(error));
    if (options.onLog) options.onLog(state.lastError);
  });

  bind();

  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  return {
    state,
    setToken(value) {
      token = String(value || '');
    },
    close() {
      state.listening = false;
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
