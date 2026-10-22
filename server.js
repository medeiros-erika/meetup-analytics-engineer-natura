'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Pool } = require('pg');
const QRCode = require('qrcode');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SECRET = process.env.SESSION_SECRET || (() => {
  console.warn('[aviso] SESSION_SECRET não definido: usando um valor temporário (sessões caem a cada reinício).');
  return crypto.randomBytes(32).toString('hex');
})();
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL não definido.'); process.exit(1); }
if (!ADMIN_PASSWORD) console.warn('[aviso] ADMIN_PASSWORD não definido: o modo apresentadora fica bloqueado.');

// URL interna do Render (sem domínio) não usa SSL; a externa (*.render.com) exige.
const dbUrl = process.env.DATABASE_URL;
const useSsl = process.env.PGSSL === 'true' || /\.render\.com/.test(dbUrl);
const pool = new Pool({ connectionString: dbUrl, ssl: useSsl ? { rejectUnauthorized: false } : false, max: 10 });

/* ─── Enquetes válidas (id → nº de opções) ─── */
const POLLS = { aq1: 4, tipo: 4, fronteira: 4, regua: 3, vencido: 4 };
for (let i = 0; i < 6; i++) POLLS['dn' + i] = 5;

/* ─── Assinaturas ─── */
const sign = v => crypto.createHmac('sha256', SECRET).update(v).digest('base64url');
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function participante(req, res, next) {
  const id = req.get('x-pid'), tk = req.get('x-ptoken');
  if (!id || !tk || !UUID.test(id) || !safeEq(tk, sign('p:' + id))) return res.status(401).json({ erro: 'sessao_invalida' });
  req.pid = id; next();
}
function admin(req, res, next) {
  const tk = req.get('x-admin');
  if (!ADMIN_PASSWORD || !tk || !safeEq(tk, sign('admin:' + ADMIN_PASSWORD))) return res.status(401).json({ erro: 'nao_autorizado' });
  next();
}

/* ─── Limite simples de taxa (memória) ─── */
const hits = new Map();
function limit(key, max, ms) {
  const now = Date.now(), arr = (hits.get(key) || []).filter(t => now - t < ms);
  if (arr.length >= max) return false;
  arr.push(now); hits.set(key, arr); return true;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some(t => now - t < 120000)) hits.delete(k); }, 60000).unref();
const rl = (name, max, ms, keyFn) => (req, res, next) =>
  limit(name + ':' + keyFn(req), max, ms) ? next() : res.status(429).json({ erro: 'muitos_envios' });

/* ─── Estado público + transmissão ao vivo (SSE) ─── */
const clients = new Set();
let stateCache = null, pending = null;

async function buildState() {
  const [palco, tallies, perguntas, votantes] = await Promise.all([
    pool.query('select slide, dn, rev from estado_palco where id = 1'),
    pool.query('select enquete_id, opcao, count(*)::int n from votos group by 1, 2'),
    pool.query(`select p.id, p.texto, p.anonima, p.tipo, p.respondida,
                       (extract(epoch from p.criada_em) * 1000)::bigint ts,
                       case when p.anonima then null else p.nome end nome,
                       (select count(*)::int from curtidas c where c.pergunta_id = p.id) likes
                  from perguntas p where p.apagada_em is null
                 order by p.criada_em limit 1000`),
    pool.query('select count(distinct participante_id)::int n from votos'),
  ]);
  const t = {};
  for (const r of tallies.rows) {
    const n = POLLS[r.enquete_id]; if (!n) continue;
    (t[r.enquete_id] = t[r.enquete_id] || Array(n).fill(0))[r.opcao] = r.n;
  }
  const p = palco.rows[0] || { slide: 0, dn: 0, rev: {} };
  return {
    palco: { slide: p.slide, dn: p.dn, rev: p.rev || {} },
    tallies: t,
    perguntas: perguntas.rows.map(r => ({ id: r.id, texto: r.texto, anon: r.anonima, tipo: r.tipo, done: r.respondida, ts: Number(r.ts), nome: r.nome, likes: r.likes })),
    votantes: votantes.rows[0].n,
  };
}
function send(res, s) { res.write(`event: estado\ndata: ${JSON.stringify({ ...s, conectados: clients.size })}\n\n`); }
function broadcast() {
  if (pending) return;
  pending = setTimeout(async () => {
    pending = null;
    try { stateCache = await buildState(); for (const c of clients) send(c, stateCache); }
    catch (e) { console.error('broadcast', e.message); }
  }, 200);
}
setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 25000).unref();

/* ─── App ─── */
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '16kb' }));
const wrap = fn => (req, res) => fn(req, res).catch(e => { console.error(req.method, req.path, e.message); res.status(500).json({ erro: 'interno' }); });

app.get('/healthz', wrap(async (req, res) => { await pool.query('select 1'); res.json({ ok: true }); }));

app.get('/api/eventos', wrap(async (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
  clients.add(res);
  req.on('close', () => { clients.delete(res); broadcast(); });
  if (!stateCache) stateCache = await buildState();
  send(res, stateCache);
  broadcast(); // atualiza a contagem de conectados para todos
}));

app.get('/api/estado', wrap(async (req, res) => res.json({ ...(await buildState()), conectados: clients.size })));

app.post('/api/participantes', rl('novo', 30, 60000, r => r.ip), wrap(async (req, res) => {
  const id = crypto.randomUUID();
  await pool.query('insert into participantes (id) values ($1)', [id]);
  res.json({ id, token: sign('p:' + id) });
}));

app.get('/api/eu', participante, wrap(async (req, res) => {
  const [p, v, c, q] = await Promise.all([
    pool.query('update participantes set visto_em = now() where id = $1 returning nome', [req.pid]),
    pool.query('select enquete_id, opcao from votos where participante_id = $1', [req.pid]),
    pool.query('select pergunta_id from curtidas where participante_id = $1', [req.pid]),
    pool.query('select id from perguntas where participante_id = $1 and apagada_em is null', [req.pid]),
  ]);
  if (!p.rowCount) return res.status(401).json({ erro: 'sessao_invalida' });
  res.json({
    nome: p.rows[0].nome || '',
    votos: Object.fromEntries(v.rows.map(r => [r.enquete_id, r.opcao])),
    curtidas: c.rows.map(r => r.pergunta_id),
    perguntas: q.rows.map(r => r.id),
  });
}));

app.put('/api/votos/:enquete', participante, rl('voto', 30, 10000, r => r.pid), wrap(async (req, res) => {
  const e = req.params.enquete, k = req.body && req.body.opcao;
  if (!POLLS[e] || !Number.isInteger(k) || k < 0 || k >= POLLS[e]) return res.status(400).json({ erro: 'voto_invalido' });
  const { rows } = await pool.query('select rev from estado_palco where id = 1');
  if (rows[0] && rows[0].rev && rows[0].rev[e]) return res.status(409).json({ erro: 'enquete_revelada' });
  await pool.query(`insert into votos (participante_id, enquete_id, opcao) values ($1, $2, $3)
                    on conflict (participante_id, enquete_id) do update set opcao = excluded.opcao, atualizado_em = now()`, [req.pid, e, k]);
  await pool.query('insert into votos_historico (participante_id, enquete_id, opcao) values ($1, $2, $3)', [req.pid, e, k]);
  broadcast(); res.json({ ok: true });
}));

app.post('/api/curtidas/:pergunta', participante, rl('curtida', 40, 10000, r => r.pid), wrap(async (req, res) => {
  const q = String(req.params.pergunta).slice(0, 64);
  const del = await pool.query('delete from curtidas where participante_id = $1 and pergunta_id = $2', [req.pid, q]);
  let curtiu = false;
  if (!del.rowCount) {
    const r = await pool.query(`insert into curtidas (participante_id, pergunta_id)
                                select $1, id from perguntas where id = $2 and apagada_em is null on conflict do nothing`, [req.pid, q]);
    if (!r.rowCount) return res.status(404).json({ erro: 'pergunta_inexistente' });
    curtiu = true;
  }
  broadcast(); res.json({ curtiu });
}));

app.post('/api/perguntas', participante, rl('pergunta', 4, 30000, r => r.pid), wrap(async (req, res) => {
  const b = req.body || {};
  const texto = typeof b.texto === 'string' ? b.texto.trim().slice(0, 280) : '';
  if (!texto) return res.status(400).json({ erro: 'texto_vazio' });
  const tipo = b.tipo === 'rodada' ? 'rodada' : 'pergunta';
  const nome = typeof b.nome === 'string' ? b.nome.trim().slice(0, 60) : '';
  const { rows } = await pool.query('select count(*)::int n from perguntas where participante_id = $1', [req.pid]);
  if (rows[0].n >= 30) return res.status(429).json({ erro: 'limite_perguntas' });
  const id = 'q' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
  if (nome) await pool.query('update participantes set nome = $2 where id = $1', [req.pid, nome]);
  await pool.query('insert into perguntas (id, participante_id, nome, texto, anonima, tipo) values ($1,$2,$3,$4,$5,$6)',
    [id, req.pid, nome || null, texto, b.anon === true, tipo]);
  broadcast(); res.json({ id });
}));

app.delete('/api/perguntas/:id', participante, wrap(async (req, res) => {
  const r = await pool.query('update perguntas set apagada_em = now() where id = $1 and participante_id = $2 and apagada_em is null', [req.params.id, req.pid]);
  if (!r.rowCount) return res.status(404).json({ erro: 'pergunta_inexistente' });
  broadcast(); res.json({ ok: true });
}));

/* ─── Apresentadora ─── */
app.post('/api/admin/login', rl('login', 8, 60000, r => r.ip), (req, res) => {
  const senha = req.body && typeof req.body.senha === 'string' ? req.body.senha : '';
  if (!ADMIN_PASSWORD || !safeEq(senha, ADMIN_PASSWORD)) return res.status(401).json({ erro: 'senha_incorreta' });
  res.json({ token: sign('admin:' + ADMIN_PASSWORD) });
});
app.get('/api/admin/check', admin, (req, res) => res.json({ ok: true }));

app.put('/api/admin/palco', admin, wrap(async (req, res) => {
  const b = req.body || {};
  const slide = Number.isInteger(b.slide) ? Math.max(0, Math.min(100, b.slide)) : 0;
  const dn = Number.isInteger(b.dn) ? Math.max(0, Math.min(5, b.dn)) : 0;
  const rev = {};
  if (b.rev && typeof b.rev === 'object') for (const k of Object.keys(b.rev)) if (POLLS[k] && b.rev[k] === true) rev[k] = true;
  await pool.query('update estado_palco set slide = $1, dn = $2, rev = $3, atualizado_em = now() where id = 1', [slide, dn, rev]);
  broadcast(); res.json({ ok: true });
}));

app.put('/api/admin/perguntas/:id/respondida', admin, wrap(async (req, res) => {
  await pool.query('update perguntas set respondida = $2 where id = $1', [req.params.id, !!(req.body && req.body.respondida)]);
  broadcast(); res.json({ ok: true });
}));

// Exporta tudo para análise depois do meetup
app.get('/api/admin/export', admin, wrap(async (req, res) => {
  const [p, v, h, q, c] = await Promise.all([
    pool.query('select id, nome, criado_em, visto_em from participantes order by criado_em'),
    pool.query('select * from votos order by atualizado_em'),
    pool.query('select * from votos_historico order by id'),
    pool.query('select * from perguntas order by criada_em'),
    pool.query('select * from curtidas order by criada_em'),
  ]);
  res.set('Content-Disposition', 'attachment; filename="meetup-scd2-export.json"');
  res.json({ exportado_em: new Date().toISOString(), participantes: p.rows, votos: v.rows, votos_historico: h.rows, perguntas: q.rows, curtidas: c.rows });
}));

/* ─── QR code do link público ─── */
const baseUrl = req => PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
app.get('/api/config', (req, res) => res.json({ url: baseUrl(req) }));
app.get('/qr.svg', wrap(async (req, res) => {
  const svg = await QRCode.toString(baseUrl(req) + '/', { type: 'svg', margin: 1, color: { dark: '#0F3A2C', light: '#FFFFFF' } });
  res.type('image/svg+xml').set('Cache-Control', 'public, max-age=300').send(svg);
}));

/* ─── Página ─── */
const page = path.join(__dirname, 'public', 'index.html');
app.use(express.static(path.join(__dirname, 'public'), { index: false }));
app.get(['/', '/palco'], (req, res) => res.sendFile(page));

(async () => {
  await pool.query(fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8'));
  app.listen(PORT, () => console.log(`Meetup no ar na porta ${PORT}`));
})().catch(e => { console.error('Falha ao iniciar:', e); process.exit(1); });
