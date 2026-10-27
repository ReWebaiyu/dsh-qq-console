// 本地验证：@ 触发判定 + 生成管线（不真的发消息，群里不产生副作用）。
import { createAutoReplyEngine } from '../dsh-qq/lib/engine.js';
import { resolveConfig } from '../dsh-qq/lib/config.js';

const cfg = resolveConfig({
  baseUrl: 'http://127.0.0.1:3999', // 故意指向不存在的后端：发送必然失败，不会打扰任何群
  accessToken: 'x',
  groups: ['1017271626'],
  aliases: ['小白'],
  chatChance: 0,
  cooldownSec: 5,
});

const replies = [];
const llm = {
  async *stream(options) {
    replies.push({ system: options.system, messages: options.messages, provider: options.provider, model: options.model });
    yield { type: 'text-delta', index: 0, text: '在呢，咋了' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  },
};
const ctx = {
  get(name) {
    if (name === 'llm') return llm;
    if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) };
    return undefined;
  },
};
const engine = createAutoReplyEngine({ ctx, cfg, log: () => {} });
engine.state.selfId = '1766131793';
engine.state.nickname = 'Regicide weapon白';

// 1) 被 @：必定触发
engine.handleEvent({
  post_type: 'message',
  message_type: 'group',
  group_id: 1017271626,
  user_id: 10001,
  message_id: 9001,
  sender: { nickname: '小明' },
  message: [{ type: 'at', data: { qq: '1766131793' } }, { type: 'text', data: { text: ' 来来来' } }],
});
// 2) 没 @ 也没叫名字、chatChance=0：应当不触发
engine.handleEvent({
  post_type: 'message',
  message_type: 'group',
  group_id: 1017271626,
  user_id: 10002,
  message_id: 9002,
  sender: { nickname: '小红' },
  message: [{ type: 'text', data: { text: '今天吃啥' } }],
});
// 3) 不带 @ 但叫了名字：触发
engine.handleEvent({
  post_type: 'message',
  message_type: 'group',
  group_id: 1017271626,
  user_id: 10003,
  message_id: 9003,
  sender: { nickname: '小刚' },
  message: [{ type: 'text', data: { text: '小白你在吗' } }],
});

await new Promise((r) => setTimeout(r, 6000));
const status = engine.status();
console.log('llm calls:', replies.length);
console.log('decisions:', JSON.stringify(status.decisions.map((d) => ({ kind: d.kind, sender: d.sender, text: d.text, reply: d.reply, sent: d.sent, error: d.error ? 'send-failed' : null })), null, 2));
console.log('\nsystem prompt head:\n' + (replies[0]?.system || '').split('\n').slice(0, 8).join('\n'));
console.log('\nuser msg:', JSON.stringify(replies[0]?.messages));
engine.dispose();
