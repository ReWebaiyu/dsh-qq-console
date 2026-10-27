import { buildQqTools } from '../dsh-qq/lib/tools.js';
import { resolveConfig } from '../dsh-qq/lib/config.js';

const cfg = resolveConfig({ baseUrl: '127.0.0.1:3999', accessToken: 'tok' });
const tools = buildQqTools(cfg);
console.log('tools:', tools.map((t) => t.name).join(', '));
const errors = [];
for (const tool of tools) {
  if (typeof tool.execute !== 'function') errors.push(tool.name + ': 缺 execute');
  if (typeof tool.output?.render !== 'function') errors.push(tool.name + ': 缺 render');
  if (!tool.parameters || tool.parameters.type !== 'object') errors.push(tool.name + ': 参数 schema 不是 object');
}
console.log('shape errors:', errors.length ? errors : 'none');

const status = tools.find((t) => t.name === 'qq_status');
const value = await status.execute({});
console.log('--- qq_status value ---');
console.log(JSON.stringify({ ok: value.ok, reachable: value.reachable, portOpen: value.portOpen, errors: value.errors, hint: value.hint }, null, 2));
console.log('--- rendered ---');
console.log(status.output.render({}, value).map((c) => c.text).join('\n'));

const priv = tools.find((t) => t.name === 'qq_send_private');
try {
  await priv.execute({ userId: 'abc', message: 'x' });
} catch (error) {
  console.log('bad id rejected:', error.message);
}
try {
  await priv.execute({ userId: '1766131793', message: 'hi' });
} catch (error) {
  console.log('offline send rejected:', error.message.slice(0, 120));
}
