const base = 'http://127.0.0.1:3013';
const post = async (path, body) => {
  const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
};
const zh = '你是本人，说话很短，一句就够，句尾常带「吧」。不要感叹号，不要客套。';
const saved = await post('/api/settings', { persona: zh });
console.log('写入后读回：', JSON.stringify(saved.settings.persona));
console.log('是否一致：', saved.settings.persona === zh);
const reset = await post('/api/settings', { persona: '', groups: ['1017271626'], watchUsers: [], chatChance: 0.15, cooldownSec: 25, maxReplyChars: 80 });
console.log('复位后：', JSON.stringify({ persona: reset.settings.persona, users: reset.settings.watchUsers, chance: reset.settings.chatChance }));
