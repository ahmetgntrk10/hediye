import express from 'express';
import pg from 'pg';

const ENV = process.env;
const TOKEN = ENV.JARVIS_TOKEN;
if (!TOKEN || TOKEN.length < 20) { console.error('JARVIS_TOKEN eksik ya da çok kısa (en az 20 karakter)'); process.exit(1); }
const GEMINI_KEY = ENV.GEMINI_API_KEY || '';
const DEEP_KEY = ENV.DEEPSEEK_API_KEY || '';
const GEMINI_MODEL = ENV.GEMINI_MODEL || 'gemini-flash-latest';
const ACCOUNTS = (ENV.EMAIL_ACCOUNTS || '').split(',').map(s => s.trim()).filter(Boolean);
const N8N_URL = ENV.N8N_WEBHOOK_URL || '';
const N8N_SECRET = ENV.N8N_SECRET || '';
const GBASE = ENV.GEMINI_BASE || 'https://generativelanguage.googleapis.com/v1beta';
const DBASE = ENV.DEEPSEEK_BASE || 'https://api.deepseek.com';
const DEEP_MODEL = ENV.DEEPSEEK_MODEL || 'deepseek-chat';

const pool = globalThis.__POOL || new pg.Pool({ connectionString: ENV.DATABASE_URL });
const q = (sql, p) => pool.query(sql, p);

async function init() {
  await q(`create table if not exists memories(id serial primary key, text text not null, created_at timestamptz default now())`);
  await q(`create table if not exists tasks(id serial primary key, text text not null, status text default 'queued', result text, created_at timestamptz default now(), done_at timestamptz)`);
  await q(`create table if not exists approvals(id serial primary key, kind text not null, payload jsonb not null, summary text not null, status text default 'pending', created_at timestamptz default now(), decided_at timestamptz, task_id int)`);
  await q(`create table if not exists notes(id serial primary key, text text not null, created_at timestamptz default now())`);
  await q(`create table if not exists reminders(id serial primary key, text text not null, due_at timestamptz not null, status text default 'pending', created_at timestamptz default now())`);
  await q(`create table if not exists chat_log(id serial primary key, role text, text text, created_at timestamptz default now())`);
}

/* ---------- araçlar ---------- */
const TOOLS = [
  { name: 'remember', description: 'Kullanıcı hakkında kalıcı bir bilgiyi hafızaya kaydeder (tercih, kişi, alışkanlık). Sadece kullanıcı söylediyse kaydet.', parameters: { type: 'OBJECT', properties: { text: { type: 'STRING' } }, required: ['text'] } },
  { name: 'recall', description: 'Hafızada arama yapar.', parameters: { type: 'OBJECT', properties: { query: { type: 'STRING' } }, required: ['query'] } },
  { name: 'web_search', description: 'İnternette güncel bilgi arar (haber, e-posta adresi, fiyat, adres...). Sonucu özet olarak döndürür.', parameters: { type: 'OBJECT', properties: { query: { type: 'STRING' } }, required: ['query'] } },
  { name: 'recall_history', description: 'Geçmiş konuşmalarda ve yapılan işlerde arama yapar (ör. daha önce kime ne mesaj atıldı, ne söylendi).', parameters: { type: 'OBJECT', properties: { query: { type: 'STRING' } }, required: ['query'] } },
  { name: 'phone_action', description: "Telefonda yapılacak işi uygulamaya iletir (sen yapmazsın, uygulama telefonda yapar). Türler: call(name) kişiyi ara; sms(name,text); wa(name,text) WhatsApp mesajı; alarm(h,m); timer(sec); torch(on); volume(level 0-100); open(app); nav(q) yol tarifi; settings(page: wifi|bluetooth|location|airplane|display|sound|battery). Birden çok kişi/iş varsa her biri için ayrı çağır. 112/155/110/156 gibi acil numaraları ASLA bu araçla arama.", parameters: { type: 'OBJECT', properties: { type: { type: 'STRING', enum: ['call', 'sms', 'wa', 'alarm', 'timer', 'torch', 'volume', 'open', 'nav', 'settings'] }, name: { type: 'STRING' }, text: { type: 'STRING' }, h: { type: 'INTEGER' }, m: { type: 'INTEGER' }, sec: { type: 'INTEGER' }, on: { type: 'BOOLEAN' }, level: { type: 'INTEGER' }, app: { type: 'STRING' }, q: { type: 'STRING' }, page: { type: 'STRING' } }, required: ['type'] } },
  { name: 'add_note', description: 'Kullanıcının söylediği notu kaydeder (not al, yaz, kaydet).', parameters: { type: 'OBJECT', properties: { text: { type: 'STRING' } }, required: ['text'] } },
  { name: 'list_notes', description: 'Kayıtlı notları listeler; query verilirse içinde arar.', parameters: { type: 'OBJECT', properties: { query: { type: 'STRING' } } } },
  { name: 'add_reminder', description: 'Hatırlatıcı kurar. when: Türkiye saatiyle YYYY-MM-DDTHH:MM biçiminde, ŞİMDİ bilgisine göre hesapla. Zamanı belirsizse kullanıcıya sor.', parameters: { type: 'OBJECT', properties: { text: { type: 'STRING' }, when: { type: 'STRING' } }, required: ['text', 'when'] } },
  { name: 'list_reminders', description: 'Bekleyen hatırlatıcıları listeler.', parameters: { type: 'OBJECT', properties: {} } },
  { name: 'cancel_reminder', description: 'Bir hatırlatıcıyı iptal eder (id ile).', parameters: { type: 'OBJECT', properties: { id: { type: 'NUMBER' } }, required: ['id'] } },
  { name: 'weather', description: 'Bir şehir için bugün ve yarının hava durumunu verir.', parameters: { type: 'OBJECT', properties: { city: { type: 'STRING' } }, required: ['city'] } },
  { name: 'list_email_accounts', description: 'Kullanıcının e-posta gönderebileceği hesapların listesi.', parameters: { type: 'OBJECT', properties: {} } },
  { name: 'send_email', description: 'E-posta gönderme isteği hazırlar. Doğrudan göndermez; kullanıcı onayına sunar. account alanını kullanıcı açıkça söylemediyse ASLA tahmin etme, önce sor.', parameters: { type: 'OBJECT', properties: { account: { type: 'STRING', description: 'Gönderen hesap, listedekilerden biri' }, to: { type: 'STRING' }, subject: { type: 'STRING' }, body: { type: 'STRING' } }, required: ['account', 'to', 'subject', 'body'] } }
];

const TAVILY_KEY = process.env.TAVILY_API_KEY || '';
async function searchTavily(query) {
  const r = await fetch('https://api.tavily.com/search', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TAVILY_KEY }, body: JSON.stringify({ query, max_results: 5, include_answer: true }) });
  if (!r.ok) throw new Error('tavily ' + r.status);
  const j = await r.json();
  return (j.answer ? j.answer + '\n' : '') + (j.results || []).map(x => x.title + ': ' + String(x.content || '').slice(0, 300)).join('\n');
}
async function searchGemini(query) {
  if (!GEMINI_KEY) throw new Error('anahtar yok');
  const r = await fetch(`${GBASE}/models/${GEMINI_MODEL}:generateContent`, {
    method: 'POST', headers: { 'x-goog-api-key': GEMINI_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: query + '\n\nKısa ve net yanıtla, kaynak adlarını yaz.' }] }], tools: [{ google_search: {} }] })
  });
  if (!r.ok) throw new Error('gemini ' + r.status);
  const j = await r.json();
  const t = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
  if (!t) throw new Error('bos');
  return t;
}
const untag = x => String(x || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, ' ').trim();
async function searchDDG(query) {
  const r = await fetch('https://html.duckduckgo.com/html/?kl=tr-tr&q=' + encodeURIComponent(query), { headers: { 'user-agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36', 'accept-language': 'tr-TR,tr;q=0.9' } });
  if (!r.ok) throw new Error('ddg ' + r.status);
  const h = await r.text();
  const out = [];
  const re = /class="result__a"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m; while ((m = re.exec(h)) && out.length < 5) out.push(untag(m[1]) + ': ' + untag(m[2]).slice(0, 300));
  if (!out.length) throw new Error('ddg bos');
  return out.join('\n');
}
async function webSearch(query) {
  const hatalar = [];
  const yollar = [];
  if (TAVILY_KEY) yollar.push(searchTavily);
  yollar.push(searchGemini, searchDDG);
  for (const f of yollar) {
    try { return { sonuc: await f(query) }; } catch (e) { hatalar.push(String(e.message || e)); }
  }
  return { hata: 'arama yapılamadı: ' + hatalar.join(', ') };
}

const trTime = d => new Date(d).toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul', weekday: 'long', day: '2-digit', month: 'long', hour: '2-digit', minute: '2-digit' });
async function weather(city) {
  const g = await (await fetch('https://geocoding-api.open-meteo.com/v1/search?count=1&language=tr&name=' + encodeURIComponent(city))).json();
  const p = g.results && g.results[0]; if (!p) return { hata: 'Şehir bulunamadı' };
  const w = await (await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${p.latitude}&longitude=${p.longitude}&current=temperature_2m,precipitation,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=Europe%2FIstanbul&forecast_days=2`)).json();
  return { sehir: p.name, simdi_derece: w.current?.temperature_2m, yagis_mm: w.current?.precipitation, bugun: { en_yuksek: w.daily?.temperature_2m_max?.[0], en_dusuk: w.daily?.temperature_2m_min?.[0], yagis_ihtimali: w.daily?.precipitation_probability_max?.[0] }, yarin: { en_yuksek: w.daily?.temperature_2m_max?.[1], en_dusuk: w.daily?.temperature_2m_min?.[1], yagis_ihtimali: w.daily?.precipitation_probability_max?.[1] } };
}

const fmtLog = x => { const d = new Date(x.created_at); const t = d.toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); return `[${t}] ${x.role === 'u' ? 'Kullanıcı' : x.role === 'a' ? 'Jarvis' : 'Yapılan iş'}: ${x.text}`; };
async function runTool(name, args, ctx) {
  args = args || {};
  if (name === 'remember') { await q('insert into memories(text) values($1)', [String(args.text || '').slice(0, 500)]); return { tamam: true }; }
  if (name === 'recall') {
    const like = '%' + String(args.query || '').slice(0, 60) + '%';
    const r = await q('select text from memories where text ilike $1 order by id desc limit 10', [like]);
    return { sonuc: r.rows.map(x => x.text) };
  }
  if (name === 'add_note') { await q('insert into notes(text) values($1)', [String(args.text || '').slice(0, 1000)]); return { tamam: true }; }
  if (name === 'list_notes') {
    const like = '%' + String(args.query || '').slice(0, 60) + '%';
    const r = await q('select id,text,created_at from notes where text ilike $1 order by id desc limit 15', [like]);
    return { notlar: r.rows.map(x => x.text) };
  }
  if (name === 'add_reminder') {
    const m = String(args.when || '').match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
    if (!m) return { hata: 'Zaman biçimi geçersiz, YYYY-MM-DDTHH:MM ver.' };
    const due = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00+03:00`);
    if (isNaN(due) || due.getTime() < Date.now() - 60000) return { hata: 'Bu zaman geçmişte. Kullanıcıya doğru zamanı sor.' };
    const r = await q('insert into reminders(text,due_at) values($1,$2) returning id', [String(args.text || '').slice(0, 300), due.toISOString()]);
    return { tamam: true, id: r.rows[0].id, zaman: trTime(due) };
  }
  if (name === 'list_reminders') {
    const r = await q(`select id,text,due_at from reminders where status='pending' order by due_at limit 20`);
    return { hatirlaticilar: r.rows.map(x => ({ id: x.id, text: x.text, zaman: trTime(x.due_at) })) };
  }
  if (name === 'cancel_reminder') { await q(`update reminders set status='done' where id=$1`, [+args.id || 0]); return { tamam: true }; }
  if (name === 'weather') return await weather(String(args.city || ''));
  if (name === 'web_search') return await webSearch(String(args.query || ''));
  if (name === 'recall_history') {
    const like = '%' + String(args.query || '').slice(0, 60) + '%';
    const r = await q('select role,text,created_at from chat_log where text ilike $1 order by id desc limit 12', [like]);
    return { sonuc: r.rows.map(x => fmtLog(x)) };
  }
  if (name === 'phone_action') {
    const t = String(args.type || '');
    if (!['call', 'sms', 'wa', 'alarm', 'timer', 'torch', 'volume', 'open', 'nav', 'settings'].includes(t)) return { hata: 'bilinmeyen tür' };
    if (t === 'call' && /^\s*(112|155|110|156)\s*$/.test(String(args.name || ''))) return { hata: 'Acil numara bu araçla aranmaz.' };
    const a = { t }; for (const k of ['name', 'text', 'h', 'm', 'sec', 'on', 'level', 'app', 'q', 'page']) if (args[k] !== undefined) a[k] = args[k];
    (ctx.actions = ctx.actions || []).push(a);
    return { tamam: true, not: 'Uygulama telefonda yapacak. Yaptım diyebilirsin, kısaca söyle.' };
  }
  if (name === 'list_email_accounts') return { hesaplar: ACCOUNTS, not: ACCOUNTS.length > 1 ? 'Birden fazla hesap var: kullanıcı söylemediyse sor.' : '' };
  if (name === 'send_email') {
    if (!ACCOUNTS.length) return { hata: 'E-posta hesabı tanımlı değil.' };
    if (!ACCOUNTS.includes(String(args.account || ''))) return { hata: 'Hesap belirtilmedi ya da listede yok. Kullanıcıya şunlardan hangisini istediğini sor: ' + ACCOUNTS.join(', ') };
    const to = String(args.to || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return { hata: 'Alıcı adresi geçersiz.' };
    const payload = { account: args.account, to, subject: String(args.subject || '').slice(0, 200), body: String(args.body || '').slice(0, 8000) };
    const summary = `E-posta: ${payload.account} hesabından ${payload.to} adresine, konu: "${payload.subject}"`;
    const r = await q('insert into approvals(kind,payload,summary,task_id) values($1,$2,$3,$4) returning id', ['send_email', JSON.stringify(payload), summary, ctx.taskId || null]);
    ctx.approvals.push(r.rows[0].id);
    return { durum: 'onay_bekliyor', id: r.rows[0].id, ozet: summary, not: 'Henüz gönderilmedi. Kullanıcıya taslağı göster, hangi hesaptan gideceğini söyle ve onay iste.' };
  }
  return { hata: 'bilinmeyen araç' };
}

async function execApproval(a) {
  if (a.kind === 'send_email') {
    if (!N8N_URL) return { ok: false, msg: 'n8n bağlı değil (N8N_WEBHOOK_URL boş).' };
    const r = await fetch(N8N_URL, { method: 'POST', headers: { 'content-type': 'application/json', 'x-jarvis-secret': N8N_SECRET }, body: JSON.stringify(a.payload) });
    return r.ok ? { ok: true, msg: 'Gönderildi.' } : { ok: false, msg: 'n8n hata verdi: ' + r.status };
  }
  return { ok: false, msg: 'bilinmeyen onay türü' };
}

/* ---------- yapay zeka ---------- */
const SYS = `Sen Jarvis'sin: kullanıcının kişisel sesli asistanı. Türkçe, kısa, doğal konuş. Telefonda sesli okunacağı için madde işareti ve uzun metin kullanma.
Kurallar:
- Bir şey yaptıysan yaptım de, yapmadıysan yapmadım de. Uydurma.
- E-posta, mesaj, silme gibi geri alınamaz işlerde önce taslağı göster ve onay iste. send_email aracı zaten göndermez, onaya koyar.
- Birden fazla e-posta hesabı varsa hangisinden gönderileceğini kullanıcı söylemediyse sor, kendin seçme.
- Kişi bilgisini (e-posta adresi gibi) bilmiyorsan web_search ile ara, bulamazsan söyle, uydurma.
- Kullanıcı bir bilgiyi hatırlamanı isterse remember kullan.
- Emin olmadığın ya da riskli bir şey varsa kullanıcıya sor.
- Telefonda yapılacak işler (arama, mesaj, alarm, zamanlayıcı, fener, ses, uygulama açma, yol tarifi, ayar) için phone_action aracını çağır; bunları sen yapamazsın, uygulama yapar.
- Cevabın en fazla 2 kısa cümle olsun. Asla "istersen", "ister misin", "yardımcı olabilirim", "bakayım mı" gibi teklif ya da soru cümlesi kurma. Güncel bilgi gerekiyorsa "bakayım" deme, web_search ile bakıp sonucu söyle.
- Önceki konuşmayı dikkate al: kısa sorular bir önceki konuyla ilgilidir.
- Kalıp komut bekleme: kullanıcı serbest konuşur, ne istediğini sen çıkar. Söylediğine bağlı yardımcı işler varsa (ör. "yarın Ankara'ya gidiyorum" → hava durumu, sabah alarmı, hatırlatma) küçük ve geri alınabilir olanları kendin yap, mesaj/mail/silme gibi riskli olanları sadece öner ve onay iste. Hepsini tek kısa cevapta söyle.
- Not almak için add_note, hatırlatmak için add_reminder, hava için weather kullan. Hatırlatıcıda saati ŞİMDİ bilgisine göre hesapla.
- Kullanıcı hakkında yeni kalıcı bilgi öğrenirsen (kişi kim, tercih, alışkanlık, hangi hesap) remember ile kaydet; bu şekilde onu zamanla tanırsın.`;

async function geminiLoop(text, history, ctx) {
  const contents = [...history.map(h => ({ role: h.r === 'u' ? 'user' : 'model', parts: [{ text: h.t }] })), { role: 'user', parts: [{ text }] }];
  for (let step = 0; step < 6; step++) {
    const r = await fetch(`${GBASE}/models/${GEMINI_MODEL}:generateContent`, {
      method: 'POST', headers: { 'x-goog-api-key': GEMINI_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: SYS + (ctx.mem ? '\nHafıza:\n' + ctx.mem : '') }] }, contents, tools: [{ functionDeclarations: TOOLS }], generationConfig: { thinkingConfig: { thinkingBudget: 0 } } })
    });
    if (!r.ok) throw new Error('Gemini ' + r.status + ' ' + (await r.text()).slice(0, 120));
    const j = await r.json();
    const parts = j.candidates?.[0]?.content?.parts || [];
    const calls = parts.filter(p => p.functionCall);
    if (!calls.length) return parts.map(p => p.text || '').join('').trim() || 'Bir şey diyemedim.';
    contents.push({ role: 'model', parts });
    const resp = [];
    for (const c of calls) {
      let out; try { ctx.used = true; out = await runTool(c.functionCall.name, c.functionCall.args, ctx); } catch (e) { out = { hata: String(e.message || e) }; }
      resp.push({ functionResponse: { name: c.functionCall.name, response: out } });
    }
    contents.push({ role: 'user', parts: resp });
  }
  return 'İşi bitiremedim, çok adım gerekti.';
}

const lowerTypes = o => Array.isArray(o) ? o.map(lowerTypes) : (o && typeof o === 'object') ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, k === 'type' && typeof v === 'string' ? v.toLowerCase() : lowerTypes(v)])) : o;
async function deepLoop(text, history, ctx) {
  const tools = TOOLS.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: lowerTypes(t.parameters) } }));
  const msgs = [{ role: 'system', content: SYS + (ctx.mem ? '\nHafıza:\n' + ctx.mem : '') }, ...history.filter(h => h && h.t).map(h => ({ role: h.r === 'u' ? 'user' : 'assistant', content: h.t })), { role: 'user', content: text }];
  for (let step = 0; step < 6; step++) {
    const r = await fetch(`${DBASE}/chat/completions`, { method: 'POST', headers: { Authorization: 'Bearer ' + DEEP_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ model: DEEP_MODEL, messages: msgs, tools }) });
    if (!r.ok) throw new Error('DeepSeek ' + r.status + ' ' + (await r.text()).slice(0, 120));
    const m = (await r.json()).choices?.[0]?.message;
    if (!m) throw new Error('DeepSeek boş cevap');
    if (!m.tool_calls || !m.tool_calls.length) return (m.content || '').trim() || 'Bir şey diyemedim.';
    msgs.push({ role: 'assistant', content: m.content || '', tool_calls: m.tool_calls });
    for (const c of m.tool_calls) {
      let out; try { ctx.used = true; out = await runTool(c.function.name, JSON.parse(c.function.arguments || '{}'), ctx); } catch (e) { out = { hata: String(e.message || e) }; }
      msgs.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(out) });
    }
  }
  return 'İşi bitiremedim, çok adım gerekti.';
}

async function deepFallback(text, history) {
  if (!DEEP_KEY) throw new Error('DeepSeek anahtarı yok');
  const msgs = [{ role: 'system', content: SYS + '\n(Şu an araçlar kapalı, sadece sohbet edebilirsin.)' }, ...history.map(h => ({ role: h.r === 'u' ? 'user' : 'assistant', content: h.t })), { role: 'user', content: text }];
  const r = await fetch(`${DBASE}/chat/completions`, { method: 'POST', headers: { Authorization: 'Bearer ' + DEEP_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ model: DEEP_MODEL, messages: msgs }) });
  if (!r.ok) throw new Error('DeepSeek ' + r.status);
  return ((await r.json()).choices?.[0]?.message?.content || '').trim();
}

async function think(text, history, opts = {}) {
  const ctx = { approvals: [], actions: [], taskId: opts.taskId, mem: '' };
  try { const m = await q('select text from memories order by id desc limit 15'); ctx.mem = m.rows.map(x => '- ' + x.text).join('\n'); } catch (e) {}
  try { const c = await q('select role,text,created_at from chat_log order by id desc limit 30'); ctx.mem += (ctx.mem ? '\n' : '') + 'SON OLAYLAR (yeniden eskiye):\n' + c.rows.map(fmtLog).join('\n'); } catch (e) {}
  try { const hp = await q(`select id,text,due_at from reminders where status='pending' order by due_at limit 10`); if (hp.rows.length) ctx.mem += '\nBEKLEYEN HATIRLATICILAR:\n' + hp.rows.map(x => `#${x.id} ${trTime(x.due_at)}: ${x.text}`).join('\n'); } catch (e) {}
  ctx.mem = 'ŞİMDİ (Türkiye saati): ' + new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Istanbul' }).slice(0, 16).replace(' ', 'T') + ' (' + trTime(new Date()) + ')\n' + ctx.mem;
  let reply, err = '';
  if (DEEP_KEY) { try { reply = await deepLoop(text, history, ctx); } catch (e) { err = String(e.message || e); } }
  if (reply === undefined && !ctx.used && GEMINI_KEY) { try { reply = await geminiLoop(text, history, ctx); } catch (e) { err += ' | ' + String(e.message || e); } }
  if (reply === undefined && !ctx.used && DEEP_KEY) { try { reply = await deepFallback(text, history); } catch (e) { err += ' | ' + String(e.message || e); } }
  if (reply === undefined) reply = 'Beynime ulaşamadım: ' + err.slice(0, 120);
  return { reply, approvals: ctx.approvals, actions: ctx.actions };
}

/* ---------- onay ---------- */
const YES = /^(evet|tamam|onay(la)?|gönder|yolla|olur|aynen|doğru|yap)\b/i;
const NO = /^(hayır|hayir|vazgeç|iptal|gönderme|yapma|olmaz|dur)\b/i;
async function latestPending() { const r = await q(`select * from approvals where status='pending' and created_at > now() - interval '1 day' order by id desc limit 1`); return r.rows[0] || null; }
async function decide(id, ok) {
  const r = await q(`select * from approvals where id=$1 and status='pending'`, [id]);
  const a = r.rows[0]; if (!a) return { ok: false, msg: 'Bu onay artık geçerli değil.' };
  if (!ok) { await q(`update approvals set status='rejected', decided_at=now() where id=$1`, [id]); return { ok: true, msg: 'Tamam, iptal ettim.' }; }
  const out = await execApproval(a);
  await q(`update approvals set status=$2, decided_at=now() where id=$1`, [id, out.ok ? 'done' : 'failed']);
  return out;
}

/* ---------- sunucu ---------- */
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => { res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization,content-type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' }); if (req.method === 'OPTIONS') return res.sendStatus(204); next(); });
const auth = (req, res, next) => {
  const h = req.headers.authorization || '';
  if (h === 'Bearer ' + TOKEN) return next();
  res.status(401).json({ error: 'yetkisiz' });
};
app.get('/health', (req, res) => res.json({ ok: true, ver: 'g3', gemini: !!GEMINI_KEY, deepseek: !!DEEP_KEY, n8n: !!N8N_URL, hesaplar: ACCOUNTS.length }));

app.post('/chat', auth, async (req, res) => {
  try {
    const text = String(req.body.text || '').trim().slice(0, 4000);
    const history = Array.isArray(req.body.history) ? req.body.history.slice(-12) : [];
    if (!text) return res.status(400).json({ error: 'boş' });
    const pend = await latestPending();
    if (pend && YES.test(text)) { const o = await decide(pend.id, true); return res.json({ reply: o.msg, approvals: [] }); }
    if (pend && NO.test(text)) { const o = await decide(pend.id, false); return res.json({ reply: o.msg, approvals: [] }); }
    await q('insert into chat_log(role,text) values($1,$2)', ['u', text]);
    const t0 = Date.now();
    const out = await think(text, history);
    out.ms = Date.now() - t0;
    for (const a of out.actions || []) await q('insert into chat_log(role,text) values($1,$2)', ['s', `${a.t} ${a.name || a.app || a.q || ''}${a.text ? ': ' + a.text : ''}${a.h !== undefined ? ' ' + a.h + ':' + String(a.m || 0).padStart(2, '0') : ''}`.trim()]);
    await q('insert into chat_log(role,text) values($1,$2)', ['a', out.reply]);
    res.json(out);
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.post('/log', auth, async (req, res) => {
  const u = String(req.body.u || '').slice(0, 500), a = String(req.body.a || '').slice(0, 500);
  if (u) await q('insert into chat_log(role,text) values($1,$2)', ['u', u]);
  if (a) await q('insert into chat_log(role,text) values($1,$2)', ['s', 'Telefonda yapıldı: ' + a]);
  res.json({ ok: true });
});
app.post('/tasks', auth, async (req, res) => {
  const list = Array.isArray(req.body.tasks) ? req.body.tasks : [req.body.text];
  const ids = [];
  for (const t of list) { const s = String(t || '').trim().slice(0, 4000); if (!s) continue; const r = await q('insert into tasks(text) values($1) returning id', [s]); ids.push(r.rows[0].id); }
  res.json({ ids });
});
app.get('/tasks', auth, async (req, res) => res.json((await q('select id,text,status,result,created_at,done_at from tasks order by id desc limit 50')).rows));
app.get('/approvals', auth, async (req, res) => res.json((await q(`select id,kind,summary,payload,status,created_at from approvals where status='pending' order by id`)).rows));
app.get('/reminders/due', auth, async (req, res) => res.json((await q(`select id,text,due_at from reminders where status='pending' and due_at <= now() order by due_at limit 10`)).rows));
app.post('/reminders/:id/ack', auth, async (req, res) => { await q(`update reminders set status='done' where id=$1`, [+req.params.id]); res.json({ ok: true }); });
app.post('/approvals/:id', auth, async (req, res) => res.json(await decide(+req.params.id, !!req.body.approve)));

let busy = false;
async function worker() {
  if (busy) return; busy = true;
  try {
    const r = await q(`update tasks set status='running' where id=(select id from tasks where status='queued' order by id limit 1) returning id,text`);
    const t = r.rows[0];
    if (t) {
      let result, st = 'done';
      try { const o = await think('GÖREV (kullanıcı yokken çalışıyorsun, gönderme işlerini onaya koy): ' + t.text, [], { taskId: t.id }); result = o.reply + (o.approvals.length ? ' [Onay bekleyen: ' + o.approvals.join(',') + ']' : ''); }
      catch (e) { st = 'failed'; result = String(e.message || e); }
      await q(`update tasks set status=$2,result=$3,done_at=now() where id=$1`, [t.id, st, result]);
    }
  } catch (e) { console.error('worker', e.message); }
  busy = false;
}

await init();
const PORT = +ENV.PORT || 3000;
app.listen(PORT, () => console.log('Jarvis sunucusu hazır :' + PORT));
setInterval(worker, 5000);
