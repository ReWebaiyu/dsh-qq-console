const r = await fetch('http://127.0.0.1:3014/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ persona: '' }) });
const j = await r.json();
console.log('persona 已复位为空：', JSON.stringify(j.settings.persona), '| groups:', j.settings.groups.join(','), '| users:', j.settings.watchUsers.length);
