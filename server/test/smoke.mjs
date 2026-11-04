import http from 'http';
import { newDb } from 'pg-mem';
const db = newDb(); const { Pool } = db.adapters.createPg(); globalThis.__POOL = new Pool();
let n8nHits = [];
const mock = http.createServer((req, res) => {
  let b = ''; req.on('data', d => b += d); req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/n8n')) { n8nHits.push(JSON.parse(b)); return res.end('{}'); }
    if (req.url.startsWith('/anthropic/v1/messages')) {
      const j = JSON.parse(b); const last = j.messages[j.messages.length - 1];
      const txt = typeof last.content === 'string' ? last.content : '';
      if (Array.isArray(last.content) && last.content[0]?.type === 'tool_result') return res.end(JSON.stringify({ content: [{ type: 'text', text: 'Claude tamam' }] }));
      if (/claudetest/.test(txt)) return res.end(JSON.stringify({ content: [{ type: 'tool_use', id: 'tu1', name: 'add_note', input: { text: 'deneme notu' } }] }));
      res.statusCode = 500; return res.end('{"error":"yok"}');
    }
    if (req.url.startsWith('/deepseek/chat/completions')) {
      const j = JSON.parse(b); const last = j.messages[j.messages.length - 1];
      if (last.role === 'tool') return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Taslak hazır. Gönderilsin mi?' } }] }));
      if (/mail/.test(last.content)) return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'send_email', arguments: JSON.stringify({ account: /yanlis/.test(last.content) ? 'baska@x.com' : 'a@x.com', to: 'info@sirket.com', subject: 'Merhaba', body: 'Uzun mesaj' }) } }] } }] }));
      if (/hatirlat/.test(last.content)) return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'c3', type: 'function', function: { name: 'add_reminder', arguments: JSON.stringify({ text: 'su ic', when: new Date(Date.now()+3600000+10800000).toISOString().slice(0,16) }) } }] } }] }));
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
const { WebSocketServer, WebSocket } = await import('ws');
const liveSeen = { outputs: [] };
const upWss = new WebSocketServer({ port: 0 }); await new Promise(r => upWss.on('listening', r));
upWss.on('connection', c => {
  c.send(JSON.stringify({ type: 'session.created' }));
  let sent = false;
  c.on('message', raw => { const m = JSON.parse(raw.toString());
    if (m.type === 'session.update') { liveSeen.tools = (m.session.tools || []).length; liveSeen.voice = m.session.voice; c.send(JSON.stringify({ type: 'session.updated' })); }
    if (m.type === 'input_audio_buffer.append' && !sent) { sent = true;
      c.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'not al' }));
      c.send(JSON.stringify({ type: 'response.function_call_arguments.done', name: 'add_note', call_id: 'cx', arguments: '{"text":"canli not"}' })); }
    if (m.type === 'conversation.item.create') liveSeen.outputs.push(m.item);
    if (m.type === 'response.create') {
      c.send(JSON.stringify({ type: 'response.audio.delta', delta: Buffer.from([1, 2, 3, 4]).toString('base64') }));
      c.send(JSON.stringify({ type: 'response.audio_transcript.done', transcript: 'Notu aldım.' }));
      c.send(JSON.stringify({ type: 'response.done' })); }
  });
});
process.env.DASHSCOPE_API_KEY = 'k'; process.env.DASHSCOPE_WS = `ws://127.0.0.1:${upWss.address().port}/api-ws/v1/realtime`;
Object.assign(process.env, { JARVIS_TOKEN: 'x'.repeat(24), GEMINI_API_KEY: 'k', DEEPSEEK_API_KEY: 'k', ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE: `http://127.0.0.1:${port}/anthropic`, DEEPSEEK_BASE: `http://127.0.0.1:${port}/deepseek`, GEMINI_BASE: `http://127.0.0.1:${port}`, EMAIL_ACCOUNTS: 'a@x.com,b@x.com', N8N_WEBHOOK_URL: `http://127.0.0.1:${port}/n8n`, PORT: '3111' });
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
const rem = await post('/chat', { text: 'hatirlat' });
console.log('hatirlatici', JSON.stringify(rem));
const cl = await post('/chat', { text: 'claudetest' });
console.log('claude', JSON.stringify(cl));
const fail=[];
if(!(alarm[1].actions&&alarm[1].actions.length===1&&alarm[1].actions[0].t==='alarm'))fail.push('phone_action calismadi');
const rl=await (await fetch('http://127.0.0.1:3111/reminders/due',{headers:H})).json();
const chk=(c,m)=>{if(!c)fail.push(m)};
const liveRes = await new Promise(resolve => { const got = { bin: 0, user: '', asst: '', ready: false }; const w = new WebSocket('ws://127.0.0.1:3111/live'); const to = setTimeout(() => { try { w.close(); } catch (e) {} resolve(got); }, 5000);
  w.on('error', () => {});
  w.on('open', () => w.send(JSON.stringify({ type: 'auth', token: 'x'.repeat(24), voice: 'Ethan' })));
  w.on('message', (d, bin) => { if (bin) { got.bin += d.length; return; } const m = JSON.parse(d.toString()); if (m.type === 'ready') { got.ready = true; w.send(Buffer.from([0, 0, 0, 0]), { binary: true }); } if (m.type === 'user') got.user = m.text; if (m.type === 'assistant') got.asst = m.text; if (m.type === 'done') { clearTimeout(to); w.close(); resolve(got); } }); });
console.log('canli', JSON.stringify(liveRes), JSON.stringify(liveSeen));
chk(liveRes.ready && liveRes.bin === 4 && liveRes.asst === 'Notu aldım.' && liveRes.user === 'not al' && liveSeen.voice === 'Ethan' && liveSeen.outputs.length === 1 && /tamam/.test(liveSeen.outputs[0].output || ''), 'canli mod calismadi');
chk(cl[1].reply==='Claude tamam'&&/Claude/.test(cl[1].engine),'claude dongusu calismadi');
chk(rem[1].reply&&!/ulaşamadım/.test(rem[1].reply),'hatirlatici cevabi yok');
chk(Array.isArray(rl)&&rl.length===0,'hatirlatici erken geldi');
chk(n8nHits.length===1&&n8nHits[0].account==='a@x.com','onay sonrasi n8n cagrilmadi');
if(fail.length){console.log('HATA',fail);process.exit(1)}
console.log('TAMAM');process.exit(0);
