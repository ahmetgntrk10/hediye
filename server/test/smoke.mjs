import http from 'http';
import { newDb } from 'pg-mem';
const db = newDb(); const { Pool } = db.adapters.createPg(); globalThis.__POOL = new Pool();
let n8nHits = [];
const mock = http.createServer((req, res) => {
  let b = ''; req.on('data', d => b += d); req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/n8n')) { n8nHits.push(JSON.parse(b)); return res.end('{}'); }
    if (req.url.startsWith('/deepseek/chat/completions')) {
      const j = JSON.parse(b); const last = j.messages[j.messages.length - 1];
      if (last.role === 'tool') return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Taslak hazır. Gönderilsin mi?' } }] }));
      if (/mail/.test(last.content)) return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'send_email', arguments: JSON.stringify({ account: /yanlis/.test(last.content) ? 'baska@x.com' : 'a@x.com', to: 'info@sirket.com', subject: 'Merhaba', body: 'Uzun mesaj' }) } }] } }] }));
      if (/alarm/.test(last.content)) return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'phone_action', arguments: JSON.stringify({ type: 'alarm', h: 7, m: 0 }) } }] } }] }));
      return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Merhaba, iyiyim.' } }] }));
    }
    const j = JSON.parse(b); const last = j.contents[j.contents.length - 1];
    if (j.tools?.[0]?.google_search) return res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'info@sirket.com' }] } }] }));
    const hasResp = last.parts.some(p => p.functionResponse);
    if (hasResp) return res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Taslak hazır. Gönderilsin mi?' }] } }] }));
    const t = last.parts[0].text;
    if (/mail/.test(t)) return res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'send_email', args: { account: /yanlis/.test(t) ? 'baska@x.com' : 'a@x.com', to: 'info@sirket.com', subject: 'Merhaba', body: 'Uzun mesaj' } } }] } }] }));
    res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Merhaba, iyiyim.' }] } }] }));
  });
});
await new Promise(r => mock.listen(0, r)); const port = mock.address().port;
Object.assign(process.env, { JARVIS_TOKEN: 'x'.repeat(24), GEMINI_API_KEY: 'k', DEEPSEEK_API_KEY: 'k', DEEPSEEK_BASE: `http://127.0.0.1:${port}/deepseek`, GEMINI_BASE: `http://127.0.0.1:${port}`, EMAIL_ACCOUNTS: 'a@x.com,b@x.com', N8N_WEBHOOK_URL: `http://127.0.0.1:${port}/n8n`, PORT: '3111' });
await import('../index.js');
const H = { 'content-type': 'application/json', authorization: 'Bearer ' + 'x'.repeat(24) };
const post = (p, b, h = H) => fetch('http://127.0.0.1:3111' + p, { method: 'POST', headers: h, body: JSON.stringify(b) }).then(async r => [r.status, await r.json()]);
const alarm = await post('/chat', { text: 'alarm kur' });
console.log('alarm', JSON.stringify(alarm));
console.log('yetkisiz', (await post('/chat', { text: 'x' }, { 'content-type': 'application/json' }))[0]);
console.log('sohbet', JSON.stringify(await post('/chat', { text: 'nasılsın' })));
console.log('yanlis hesap', JSON.stringify(await post('/chat', { text: 'mail at yanlis' })));
console.log('mail', JSON.stringify(await post('/chat', { text: 'mail at' })));
console.log('onay bekleyen', JSON.stringify((await (await fetch('http://127.0.0.1:3111/approvals', { headers: H })).json()).map(a => a.summary)));
console.log('n8n önce', n8nHits.length);
console.log('evet', JSON.stringify(await post('/chat', { text: 'evet' })));
console.log('n8n sonra', JSON.stringify(n8nHits));
console.log('gôrev', JSON.stringify(await post('/tasks', { tasks: ['a@x.com e mail at'] })));
await new Promise(r => setTimeout(r, 6500));
console.log('gorevler', JSON.stringify((await (await fetch('http://127.0.0.1:3111/tasks', { headers: H })).json()).map(t => [t.status, t.result])));
console.log('görev onayı', JSON.stringify((await (await fetch('http://127.0.0.1:3111/approvals', { headers: H })).json()).map(a => a.summary)));
const fail=[];
if(!(alarm[1].actions&&alarm[1].actions.length===1&&alarm[1].actions[0].t==='alarm'))fail.push('phone_action calismadi');
const chk=(c,m)=>{if(!c)fail.push(m)};
chk(n8nHits.length===1&&n8nHits[0].account==='a@x.com','onay sonrasi n8n cagrilmadi');
if(fail.length){console.log('HATA',fail);process.exit(1)}
console.log('TAMAM');process.exit(0);
