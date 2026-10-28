import { buildQqTools } from '../dsh-qq/lib/tools.js';
import { resolveConfig } from '../dsh-qq/lib/config.js';

const cfg = resolveConfig({ baseUrl: 'http://127.0.0.1:3000', accessToken: 'dshqq_7c41b95e2a6d4083' });
const tools = Object.fromEntries(buildQqTools(cfg).map((t) => [t.name, t]));

const cases = [
  ['private self', { chat: 'private', id: '1766131793', count: 3 }],
  ['group', { chat: 'group', id: '1017271626', count: 3 }],
  ['recent', { chat: 'recent', count: 5 }],
];
for (const [label, args] of cases) {
  try {
    const value = await tools.qq_history.execute(args);
    const text = JSON.stringify(value);
    const problems = [];
    const walk = (v, path) => {
      if (v === undefined) problems.push(path + '=undefined');
      else if (typeof v === 'number' && !Number.isFinite(v)) problems.push(path + '=' + v);
      else if (typeof v === 'function') problems.push(path + '=function');
      else if (typeof v === 'bigint') problems.push(path + '=bigint');
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, path + '.' + k);
    };
    walk(value, '');
    console.log('--- ' + label + ' --- ok, json bytes=' + text.length + ', problems=' + (problems.length ? problems.join(', ') : 'none'));
    console.log(text.slice(0, 400));
  } catch (error) {
    console.log('--- ' + label + ' --- ERROR ' + error.message);
  }
}
