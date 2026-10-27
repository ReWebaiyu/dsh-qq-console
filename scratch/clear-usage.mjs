import { readFileSync, writeFileSync } from 'node:fs';
const file = 'D:/WenJian/DP0.0.1/dsh-qq/data/admin.json';
const data = JSON.parse(readFileSync(file, 'utf8'));
data.usage = {};
writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
console.log('usage cleared, settings keys:', Object.keys(data.settings).join(','));
