// 用本地假 OneBot 服务验证 dsh-qq 的成功路径（发送/历史/会话/状态）。
import http from 'node:http';
import { buildQqTools } from '../dsh-qq/lib/tools.js';
import { resolveConfig } from '../dsh-qq/lib/config.js';

const calls = [];
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const action = req.url.replace(/^\//, '');
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    calls.push({ action, body, auth: req.headers.authorization });
    const send = (data) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', retcode: 0, data }));
    };
    switch (action) {
      case 'get_login_info':
        return send({ user_id: 1766131793, nickname: 'ReWebaiyu' });
      case 'get_status':
        return send({ online: true, good: true });
      case 'get_version_info':
        return send({ app_name: 'NapCat', app_version: '4.18.41', protocol_version: 'v11' });
      case 'send_private_msg':
      case 'send_group_msg':
        return send({ message_id: 12345 });
      case 'get_friend_msg_history':
        return send({
          messages: [
            { message_id: 1, time: 1770000000, sender: { user_id: 10001, nickname: '小明' }, message: [{ type: 'text', data: { text: '你好' } }], raw_message: '你好' },
            { message_id: 2, time: 1770000060, sender: { user_id: 1766131793, nickname: '我' }, message: [{ type: 'text', data: { text: '在的' } }, { type: 'image', data: {} }] },
          ],
        });
      case 'get_group_msg_history':
        return send({ messages: [{ message_id: 3, time: 1770000120, sender: { user_id: 10002, card: '群名片', nickname: '昵称' }, message: [{ type: 'text', data: { text: '群消息' } }] }] });
      case 'get_recent_contact':
        return send([
          { chatType: 1, peerUin: '10001', remark: '', peerName: '小明', unreadMsgCnt: 2, msgTime: 1770000000, lastestMsg: '你好' },
          { chatType: 2, peerUin: '123456', remark: '技术群', peerName: '技术群', unreadMsgCnt: 0, msgTime: 1770000300, lastestMsg: { message: [{ type: 'text', data: { text: '群里的最后一条' } }] } },
        ]);
      default:
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ status: 'failed', retcode: 1404, data: null, message: 'unknown action' }));
    }
  });
});

await new Promise((r) => server.listen(3000, '127.0.0.1', r));
const cfg = resolveConfig({ baseUrl: 'http://127.0.0.1:3000', accessToken: 'secret-token' });
const tools = buildQqTools(cfg);
const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

const show = (title, value) => {
  console.log('\n=== ' + title + ' ===');
  console.log(JSON.stringify(value, null, 2));
};

const status = await byName.qq_status.execute({});
show('status', { ok: status.ok, selfId: status.selfId, nickname: status.nickname, online: status.online, appVersion: status.appVersion });

show('send private', await byName.qq_send_private.execute({ userId: '10001', message: '来自 DSH 的测试消息' }));
show('send group', await byName.qq_send_group.execute({ groupId: '123456', message: '群测试', atUserIds: ['10001'] }));
show('history private', await byName.qq_history.execute({ chat: 'private', id: '10001', count: 2 }));
show('history group', await byName.qq_history.execute({ chat: 'group', id: '123456' }));
show('recent', await byName.qq_history.execute({ chat: 'recent' }));

console.log('\n=== rendered group history ===');
console.log(byName.qq_history.output.render({ chat: 'group', id: '123456' }, await byName.qq_history.execute({ chat: 'group', id: '123456' })).map((c) => c.text).join('\n'));

console.log('\n=== backend status ===');
show('backend', await byName.qq_backend.execute({ action: 'status' }));

console.log('\n=== auth header seen ===');
console.log(calls[0].auth);
console.log('\n=== group send body (segments + at) ===');
console.log(JSON.stringify(calls.find((c) => c.action === 'send_group_msg').body));
server.close();
