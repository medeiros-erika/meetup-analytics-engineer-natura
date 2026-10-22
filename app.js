(function(){
  'use strict';
  const $ = id => document.getElementById(id);
  const slides = [...document.querySelectorAll('.slide')];
  const store = {
    get(k){ try { return localStorage.getItem(k); } catch(e){ return null; } },
    set(k,v){ try { localStorage.setItem(k,v); } catch(e){} },
    del(k){ try { localStorage.removeItem(k); } catch(e){} }
  };

  /* ─── Votações (ids e nº de opções iguais aos do server.js) ─── */
  const OPTS = ['Append-only','Merge','Não versionar','Merge + SCD2','Snapshot SCD2'];
  const DN = [
    {c:'Pagamentos de fatura recebidos da Dock', h:'O pagamento muda depois de recebido?', a:0, w:'Append-only: é evento imutável. Cada pagamento é um fato que aconteceu e não se altera.'},
    {c:'Plano atual do cliente na home do app', h:'Quem consome precisa do passado?', a:1, w:'Merge: a home só precisa do presente. O histórico, se alguém precisar, mora em outra camada.'},
    {c:'Parcela renegociada com novo vencimento', h:'A origem já informa quando a nova condição começa?', a:3, w:'Merge + SCD2 manual: a origem traz a nova vigência. Chave = parcela + dt_inicio_vigencia; a vigência anterior é fechada.'},
    {c:'Dias de atraso da obrigação', h:'Esse valor muda sem nenhum evento na origem?', a:2, w:'Não versionar: muda sozinho com o calendário. Calcule na data de referência; versionar gera uma versão por dia e congela o valor.'},
    {c:'Tolerância de bloqueio definida pelo Crédito', h:'Precisamos reproduzir decisões antigas?', a:4, w:'SCD2: é a régua, que precisa ser reproduzível em qualquer data. No case, é dado versionado com vigência, ajustado pelo Crédito sem deploy.'},
    {c:'Situação de advertência do título no SAP', h:'A origem guarda o histórico dessa situação?', a:4, w:'Snapshot SCD2 com strategy check: a origem só mostra a situação atual, e ela define se o título é cobrável.'}
  ];
  const POLLS = {
    aq1: {q:'Alguém já precisou explicar um número do passado e a tabela só tinha o presente?', o:['Sim, e descobri na reunião com o negócio','Sim, reconstruí a partir de time travel Databricks (VERSION AS OF)','Fui eu que sobrescrevi o histórico','Nunca aconteceu comigo (ainda)']},
    tipo: {q:'Qual tipo de SCD responde “o que era verdade em D?”', o:['Tipo 1','Tipo 2','Tipo 3','Tipo 6'], c:1, w:'Tipo 2: nova linha por mudança, com vigência. O 6 também guarda o histórico, mas é o 2 com uma coluna de valor atual.'},
    fronteira: {q:'Uma venda em 2026-05-01 cai em qual versão do cliente C-200 (Bronze até 2026-05-01, Gold desde 2026-05-01)?', o:['Bronze','Gold','Nas duas','Depende'], c:1, w:'Gold, com a janela semiaberta [início, fim). Sem uma convenção única no time, a venda conta duas vezes ou some.'},
    regua: {q:'Se o Crédito mudar a régua default amanhã, a decisão de 15/09 muda?', o:['Sim','Não','Depende'], c:1, w:'Não. A decisão de 15/09 usa a versão vigente em 15/09. A mudança abre uma nova vigência e não reescreve o passado.'},
    vencido: {q:'A obrigação vira VENCIDA só porque o dia virou, sem evento na origem. Num incremental, o que acontece?', o:['Vira VENCIDA normalmente','Fica como A VENCER','Some da tabela','Duplica a linha'], c:1, w:'Fica como A VENCER: o incremental só vê o que teve evento. Foi o que aconteceu entre 02/09 e 13/10.'}
  };
  DN.forEach((x,i)=>{ POLLS['dn'+i] = {q:x.c, h:x.h, o:OPTS, c:x.a, w:x.w}; });

  /* ─── Estado ─── */
  const IS_PALCO = location.pathname.replace(/\/+$/,'') === '/palco';
  let S = {palco:{slide:0,dn:0,rev:{}}, tallies:{}, perguntas:[], votantes:0, conectados:0};
  let live = false, editor = false, mode = IS_PALCO ? 'palco' : 'plateia', palcoSynced = false;
  let palco = {slide:0, dn:0, rev:{}};
  let me = {pid: store.get('meetup_pid'), token: store.get('meetup_ptoken'), nome: store.get('meetup_nome') || '', votos:{}, curtidas:new Set(), perguntas:new Set()};
  let adminToken = store.get('meetup_admin');
  const manual = {};
  const isObj = o => o && typeof o === 'object' && !Array.isArray(o);

  async function api(method, url, body, asAdmin){
    const h = {};
    if (body !== undefined) h['Content-Type'] = 'application/json';
    if (me.pid && me.token) { h['x-pid'] = me.pid; h['x-ptoken'] = me.token; }
    if (asAdmin && adminToken) h['x-admin'] = adminToken;
    const r = await fetch(url, {method, headers:h, body: body !== undefined ? JSON.stringify(body) : undefined});
    let j = null; try { j = await r.json(); } catch(e){}
    if (!r.ok) { const e = new Error((j && j.erro) || ('http_' + r.status)); e.status = r.status; e.code = j && j.erro; throw e; }
    return j;
  }

  function tally(pid){
    const n = POLLS[pid].o.length;
    if (live) { const t = S.tallies && S.tallies[pid]; return Array.from({length:n}, (_,i)=> (t && Number(t[i])) || 0); }
    const c = Array(n).fill(0); if (manual[pid]) manual[pid].forEach((k,i)=>c[i]=k); return c;
  }
  function questions(){
    return (S.perguntas || []).filter(isObj).map(q=>({
      key: String(q.id), id: String(q.id), texto: String(q.texto || '').slice(0,280), anon: q.anon === true,
      ts: Number(q.ts) || 0, tipo: q.tipo === 'rodada' ? 'rodada' : 'pergunta', likes: Number(q.likes) || 0,
      done: q.done === true, nome: typeof q.nome === 'string' ? q.nome : '', mine: me.perguntas.has(String(q.id))
    }));
  }
  const revealed = pid => !!(palco.rev && palco.rev[pid]);
  function currentPoll(i){
    const p = slides[i] && slides[i].dataset.poll;
    if (!p) return null;
    return p === 'dn' ? 'dn' + Math.max(0, Math.min(DN.length-1, palco.dn|0)) : p;
  }
  function el(tag, cls, text){ const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  /* ═════════ PLATEIA ═════════ */
  function setTab(t){
    $('tabAgora').classList.toggle('on', t==='agora'); $('tabAgora').setAttribute('aria-selected', t==='agora');
    $('tabPerg').classList.toggle('on', t==='perg'); $('tabPerg').setAttribute('aria-selected', t==='perg');
    $('vAgora').hidden = t!=='agora'; $('vPerg').hidden = t!=='perg';
  }
  $('tabAgora').onclick = ()=>setTab('agora');
  $('tabPerg').onclick = ()=>setTab('perg');
  $('qNome').value = me.nome;

  function renderAudience(){
    const i = Math.max(0, Math.min(slides.length-1, palco.slide|0));
    const s = slides[i];
    const eb = s.querySelector('.eyebrow'); const h = s.querySelector('h1,h2');
    $('audSlide').textContent = `Slide ${i+1} de ${slides.length}` + (eb ? ' · ' + eb.textContent : '');
    $('audTitle').textContent = h ? h.textContent : '';
    const card = $('audCard'); card.replaceChildren();
    const pid = currentPoll(i);
    const ready = live && !!me.pid;
    if (pid) {
      const P = POLLS[pid], my = me.votos[pid], rev = revealed(pid), showBars = rev || P.c === undefined;
      const c = tally(pid), tot = c.reduce((a,b)=>a+b,0);
      if (pid.startsWith('dn')) card.append(el('p','aud-eyebrow',`Dinâmica · caso ${+pid.slice(2)+1} de ${DN.length}`));
      card.append(el('p','q',P.q));
      if (P.h) card.append(el('p','hint','Dica: ' + P.h));
      P.o.forEach((o,k)=>{
        const b = el('button','aopt'); b.type='button';
        if (my === k) b.classList.add('mine');
        if (rev && P.c === k) b.classList.add('ok');
        const f = el('span','fill'); if (showBars && tot) f.style.width = (c[k]/tot*100)+'%';
        b.append(f, el('span',null,o + (my===k ? ' · seu voto' : '')));
        if (showBars) b.append(el('b',null,String(c[k])));
        b.disabled = !ready || rev;
        b.onclick = ()=>vote(pid,k);
        card.append(b);
      });
      if (rev && P.w) card.append(el('p','ans',P.w));
      else card.append(el('p','hint', !ready ? 'Conectando… seu voto poderá ser enviado em instantes.' : (my === undefined ? 'Toque numa opção para votar. Dá para trocar até a resposta ser revelada.' : (P.c === undefined ? 'Voto registrado. Os resultados aparecem ao vivo.' : 'Voto registrado. A resposta aparece aqui quando a Erika revelar.'))));
    } else if (i === slides.length-1) {
      card.append(el('p','aud-eyebrow','Rodada final'));
      card.append(el('p','q','Qual tabela do seu domínio deveria ser SCD2 e hoje não é, ou o contrário?'));
      const ta = el('textarea'); ta.id = 'rodadaText'; ta.maxLength = 280; ta.placeholder = 'Uma frase basta.';
      const row = el('div','arow'); const lab = el('label','achk'); const cb = el('input'); cb.type='checkbox'; cb.id='rodadaAnon'; lab.append(cb, document.createTextNode(' Não mostrar meu nome'));
      const send = el('button','abtn','Enviar'); send.type='button'; send.disabled = !ready;
      send.onclick = async ()=>{ const t = ta.value.trim(); if (!t) return; send.disabled = true; const ok = await addQuestion(t, cb.checked, 'rodada'); if (ok) { ta.value=''; send.textContent='Enviado'; setTimeout(()=>{ send.textContent='Enviar'; send.disabled=false; }, 1500); } else send.disabled=false; };
      row.append(lab, send); card.append(ta, row);
      const mineR = questions().filter(q=>q.mine && q.tipo==='rodada');
      if (mineR.length) card.append(el('p','hint',`Você já enviou ${mineR.length} resposta${mineR.length>1?'s':''}.`));
    } else {
      const ask = s.querySelector('.ask-q');
      if (ask) {
        card.append(el('p','aud-eyebrow','Pergunta para a sala'));
        card.append(el('p','q',ask.textContent));
        card.append(el('p','hint','Responda em voz alta ou mande por escrito: a resposta entra no painel da Erika.'));
        const b = el('button','abtn ghost','Responder por escrito'); b.type='button';
        b.onclick = ()=>{ setTab('perg'); $('qText').placeholder = 'Sobre: ' + ask.textContent; $('qText').focus(); };
        card.append(b);
      } else {
        card.append(el('p','q','Acompanhe na tela.'));
        card.append(el('p','hint','Quando houver votação, ela aparece aqui. Tem uma dúvida? Mande na aba Perguntas a qualquer momento.'));
      }
    }
    renderAudQs();
  }

  function renderAudQs(){
    const qs = questions().filter(q=>q.tipo==='pergunta').sort((a,b)=> (a.done-b.done) || (b.likes-a.likes) || (a.ts-b.ts));
    $('qCount').textContent = qs.length ? `(${qs.length})` : '';
    const list = $('qList'); list.replaceChildren();
    if (!qs.length) { list.append(el('p','empty','Nenhuma pergunta ainda. Seja a primeira pessoa a perguntar.')); return; }
    const ready = live && !!me.pid;
    qs.forEach(q=>{
      const item = el('div','qitem' + (q.done?' done':''));
      item.append(el('p','qt',q.texto));
      const who = q.mine ? 'Você' + (q.anon ? ' (sem nome na tela)' : '') : (q.anon ? 'Sem nome' : (q.nome || 'Alguém'));
      item.append(el('p','qm', who + (q.done ? ' · respondida' : '')));
      const liked = me.curtidas.has(q.id);
      const lk = el('button','like' + (liked?' on':''), '♥ ' + q.likes); lk.type='button'; lk.setAttribute('aria-label', 'Curtir pergunta, ' + q.likes + ' curtidas');
      lk.disabled = !ready; lk.onclick = ()=>toggleLike(q.id);
      item.append(lk);
      if (q.mine) { const d = el('button','qdel','Apagar'); d.type='button'; d.onclick = ()=>delQuestion(q.id); item.append(d); }
      list.append(item);
    });
  }

  $('qForm').addEventListener('submit', async e=>{
    e.preventDefault();
    const t = $('qText').value.trim(); if (!t) return;
    $('qSend').disabled = true;
    const ok = await addQuestion(t, $('qAnon').checked, 'pergunta');
    $('qSend').disabled = false;
    if (ok) $('qText').value = '';
  });
  $('qNome').addEventListener('change', ()=>{ me.nome = $('qNome').value.trim().slice(0,60); store.set('meetup_nome', me.nome); });

  function showErr(msg){ const e = $('qErr'); e.textContent = msg; e.hidden = !msg; }
  function errMsg(e){
    const c = e && e.code;
    if (c === 'muitos_envios') return 'Muitos envios seguidos. Espere alguns segundos e tente de novo.';
    if (c === 'limite_perguntas') return 'Você chegou ao limite de 30 perguntas.';
    if (c === 'enquete_revelada') return 'A resposta já foi revelada: a votação desta pergunta fechou.';
    if (c === 'sessao_invalida') return 'Sua sessão expirou. Recarregue a página.';
    return 'Não foi possível enviar agora. Tente de novo em instantes.';
  }
  async function vote(pid, k){
    if (!me.pid || revealed(pid)) return;
    const prev = me.votos[pid]; me.votos[pid] = k; renderAll();
    try { await api('PUT', '/api/votos/' + encodeURIComponent(pid), {opcao:k}); showErr(''); }
    catch(e){ if (prev === undefined) delete me.votos[pid]; else me.votos[pid] = prev; renderAll(); alertAud(errMsg(e)); }
  }
  async function toggleLike(id){
    if (!me.pid) return;
    try { const r = await api('POST', '/api/curtidas/' + encodeURIComponent(id)); if (r && r.curtiu) me.curtidas.add(id); else me.curtidas.delete(id); renderAll(); showErr(''); }
    catch(e){ showErr(errMsg(e)); }
  }
  async function addQuestion(texto, anon, tipo){
    if (!me.pid) { showErr('Conectando… tente de novo em instantes.'); return false; }
    me.nome = $('qNome').value.trim().slice(0,60); store.set('meetup_nome', me.nome);
    try { const r = await api('POST', '/api/perguntas', {texto: texto.slice(0,280), anon: !!anon, tipo, nome: me.nome}); if (r && r.id) me.perguntas.add(String(r.id)); showErr(''); renderAll(); return true; }
    catch(e){ showErr(errMsg(e)); alertAud(errMsg(e)); return false; }
  }
  async function delQuestion(id){
    try { await api('DELETE', '/api/perguntas/' + encodeURIComponent(id)); me.perguntas.delete(id); renderAll(); } catch(e){ showErr(errMsg(e)); }
  }
  let audMsgT = null;
  function alertAud(msg){ const n = $('audMsg'); n.textContent = msg; n.hidden = false; clearTimeout(audMsgT); audMsgT = setTimeout(()=>{ n.hidden = true; }, 4000); }

  async function initParticipante(){
    if (me.pid && me.token) {
      try {
        const r = await api('GET', '/api/eu');
        me.votos = isObj(r.votos) ? r.votos : {};
        me.curtidas = new Set((r.curtidas || []).map(String));
        me.perguntas = new Set((r.perguntas || []).map(String));
        if (!me.nome && r.nome) { me.nome = r.nome; $('qNome').value = r.nome; }
        renderAll(); return;
      } catch(e) { if (e.status !== 401) { setTimeout(initParticipante, 4000); return; } }
    }
    try {
      const r = await api('POST', '/api/participantes');
      me.pid = r.id; me.token = r.token; store.set('meetup_pid', r.id); store.set('meetup_ptoken', r.token);
      me.votos = {}; me.curtidas = new Set(); me.perguntas = new Set();
      renderAll();
    } catch(e) { me.pid = null; setTimeout(initParticipante, 4000); }
  }

  /* ═════════ PALCO ═════════ */
  const stage = $('stage');
  let cur = 0;
  function fit(){ const s = Math.min(window.innerWidth/1600, (window.innerHeight-44)/900); stage.style.transform = `scale(${s})`; }
  window.addEventListener('resize', fit);

  let palcoTimer = null;
  function pushPalco(){
    if (!editor || mode !== 'palco') return;
    clearTimeout(palcoTimer);
    palcoTimer = setTimeout(()=>{ api('PUT', '/api/admin/palco', {slide: palco.slide|0, dn: palco.dn|0, rev: palco.rev || {}}, true).catch(e=>{ if (e.status === 401) needLogin(); }); }, 150);
  }
  function go(i, push = true){
    cur = Math.max(0, Math.min(slides.length-1, i));
    slides.forEach((s,k)=>s.classList.toggle('active', k===cur));
    $('progress').style.width = ((cur+1)/slides.length*100)+'%';
    $('notes').replaceChildren(el('b',null,'Notas da apresentadora'), document.createTextNode(slides[cur].dataset.notes || ''));
    if (push) { palco.slide = cur; pushPalco(); }
    if (slides[cur].querySelector('#rgDate')) rgRender();
  }

  const toggleQr = ()=>{ $('qrOverlay').hidden = !$('qrOverlay').hidden; };
  document.addEventListener('keydown', e=>{
    if (mode !== 'palco' || !editor) return;
    const t = e.target;
    if (t && (t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && t.type !== 'checkbox' && t.type !== 'range'))) return;
    if (t && t.tagName === 'INPUT' && t.type === 'range' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return;
    if (['ArrowRight','PageDown',' '].includes(e.key)) { e.preventDefault(); go(cur+1); }
    else if (['ArrowLeft','PageUp'].includes(e.key)) { e.preventDefault(); go(cur-1); }
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(slides.length-1);
    else if (e.key.toLowerCase() === 'n') $('notes').hidden = !$('notes').hidden;
    else if (e.key.toLowerCase() === 'p') toggleQa();
    else if (e.key.toLowerCase() === 'c') toggleQr();
    else if (e.key.toLowerCase() === 'q') { const a = slides[cur].querySelector('.ask'); if (a) a.classList.toggle('open'); }
    else if (e.key.toLowerCase() === 'f') { try { if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(()=>{}); else document.exitFullscreen().catch(()=>{}); } catch(_){} }
    else if (e.key === 'Escape') { $('qa').hidden = true; $('help').hidden = true; $('qrOverlay').hidden = true; }
  });
  $('bPrev').onclick = ()=>go(cur-1);
  $('bNext').onclick = ()=>go(cur+1);
  $('bNotes').onclick = ()=>{ $('notes').hidden = !$('notes').hidden; };
  $('bHelp').onclick = ()=>{ $('help').hidden = !$('help').hidden; };
  $('bAud').onclick = ()=>{ window.open('/', '_blank', 'noopener'); };
  $('bQa').onclick = ()=>toggleQa();
  $('bQr').onclick = toggleQr; $('qrOverlay').onclick = toggleQr;
  $('qaClose').onclick = ()=>{ $('qa').hidden = true; };
  $('bExport').onclick = async ()=>{
    try {
      const r = await fetch('/api/admin/export', {headers:{'x-admin': adminToken || ''}});
      if (!r.ok) { if (r.status === 401) needLogin(); return; }
      const blob = await r.blob(); const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = 'meetup-scd2-export.json'; document.body.append(a); a.click(); a.remove();
      setTimeout(()=>URL.revokeObjectURL(url), 5000);
    } catch(e){}
  };

  document.querySelectorAll('.ask').forEach(a=>a.addEventListener('click', e=>{ if (e.target.closest('.lp')) return; a.classList.toggle('open'); }));
  document.querySelectorAll('[data-show]').forEach(b=>b.addEventListener('click', ()=>{ $(b.dataset.show).classList.add('show'); b.hidden = true; }));
  document.querySelectorAll('[data-toggle]').forEach(c=>c.addEventListener('click', ()=>{ const r = c.querySelector('.reveal'); r.classList.toggle('show'); const h = c.querySelector('.reveal-hint'); if (h) h.hidden = r.classList.contains('show'); }));
  document.querySelectorAll('.guess').forEach(g=>g.addEventListener('click', ()=>{ const on = !g.classList.contains('shown'); g.classList.toggle('shown', on); g.textContent = on ? g.dataset.answer : 'Como se escreve? ▸'; }));
  document.querySelectorAll('tr.clickable').forEach(r=>r.addEventListener('click', ()=>r.classList.toggle('picked')));
  const checks = [...document.querySelectorAll('.check input')];
  checks.forEach(c=>c.addEventListener('change', ()=>{ c.parentElement.classList.toggle('done', c.checked); $('chkCount').textContent = `${checks.filter(x=>x.checked).length} de ${checks.length}`; }));

  function revealPoll(pid){ palco.rev = Object.assign({}, palco.rev, {[pid]: true}); pushPalco(); renderAll(); }
  function renderStagePolls(){
    document.querySelectorAll('[data-lp]').forEach(box=>{
      const pid = box.dataset.lp, P = POLLS[pid], c = tally(pid), tot = c.reduce((a,b)=>a+b,0), rev = revealed(pid);
      const hideBars = P.c !== undefined && !rev;
      box.replaceChildren();
      P.o.forEach((o,k)=>{
        const r = el(live ? 'div' : 'button', 'lp-row' + (rev && P.c===k ? ' ok' : ''));
        const f = el('span','fill'); if (!hideBars && tot) f.style.width = (c[k]/tot*100)+'%';
        r.append(f, el('span',null,o), el('b',null, hideBars ? '·' : String(c[k])));
        if (!live) { r.type = 'button'; r.onclick = e=>{ e.stopPropagation(); (manual[pid] = manual[pid] || Array(P.o.length).fill(0))[k]++; renderAll(); }; }
        box.append(r);
      });
      const meta = el('div','lp-meta');
      meta.append(el('span','lp-total', `${tot} voto${tot===1?'':'s'}`));
      if (!live) meta.append(el('span',null,'offline: clique para contar mãos'));
      if (P.c !== undefined && !rev) { const b = el('button','btn orange','Revelar resultado'); b.type='button'; b.style.padding='6px 14px'; b.style.fontSize='14px'; b.onclick = e=>{ e.stopPropagation(); revealPoll(pid); }; meta.append(b); }
      else if (P.c !== undefined && rev && P.w) { const w = el('span',null,P.w); w.style.flex='1'; meta.append(w); }
      box.append(meta);
    });
    const t2 = document.querySelector('tr.tipo2'); if (t2) t2.classList.toggle('hl', revealed('tipo'));
    const vl = $('vencidoLesson'); if (vl) vl.classList.toggle('show', revealed('vencido'));
  }

  /* ─── Mapa de decisão ─── */
  const Q = [
    {q:'O registro é um evento que não muda depois de acontecer?', s:'Pagamento recebido, clique, decisão emitida', r:'Append-only', d:'Incremental sem unique_key. Cuidado com duplicatas em reprocessamento.', c:'#5A6472'},
    {q:'Só o estado atual importa para quem consome?', s:'Ninguém vai perguntar “o que era em D?”', r:'Merge (SCD1)', d:'Upsert pela chave natural. O histórico de mudanças é descartado de propósito.', c:'#A8552F'},
    {q:'O valor muda sozinho com o calendário?', s:'Dias de atraso, idade da dívida, status vencido', r:'Não versione', d:'Calcule na data de referência. Versionar gera uma versão por dia sem mudança real, e o valor congela.', c:'#3F4A5A'},
    {q:'A origem já entrega a vigência ou a versão?', s:'Datas de início e fim, número da renegociação', r:'Merge + SCD2 manual', d:'Chave composta: id + dt_inicio_vigencia. O merge garante idempotência; a vigência anterior é fechada ao abrir a nova.', c:'#9E396C'},
    {q:'A origem só mostra o presente e você precisa do passado?', s:'Status do título, regra cadastrada', r:'Snapshot SCD2', d:'dbt snapshot: strategy check sem updated_at confiável, timestamp quando há. Liste as colunas versionadas como contrato.', c:'#1B6B50'}
  ];
  const CASES = ['Log de login no app','Status atual do pedido para a operação','Idade da dívida','Contrato com aditivo de prazo (origem traz vigência)','Segmento da consultora, que muda por campanha','Caso da sala'];
  let wkIdx = 0, wkDone = false;
  function wkRender(){
    const st = $('wkSteps'); st.replaceChildren();
    Q.forEach((x,i)=>{
      const d = el('div','step' + (i===wkIdx&&!wkDone?' current':'') + (i<wkIdx?' passed':'') + (wkDone&&i===wkIdx?' hit':''));
      const qq = el('span','q',x.q); qq.append(el('small',null,x.s));
      d.append(el('span','n',String(i+1)), qq);
      if (i<wkIdx) { const t = el('span','tag','não'); t.style.background='#EDE9E0'; t.style.color='#5A6472'; d.append(t); }
      if (wkDone && i===wkIdx) { const t = el('span','tag','sim'); t.style.background='#1B6B50'; t.style.color='#fff'; d.append(t); }
      st.append(d);
    });
    const r = $('wkResult'); r.replaceChildren();
    const lab = (t)=>{ const p = el('p',null,t); p.style.cssText='font-size:13px;font-weight:700;letter-spacing:2.5px;text-transform:uppercase;opacity:.8'; return p; };
    if (wkDone && wkIdx < Q.length) { const x = Q[wkIdx]; r.style.background = x.c; const h = el('p','serif',x.r); h.style.cssText='font-size:40px;font-weight:700'; const d = el('p',null,x.d); d.style.fontSize='17px'; r.append(lab('Estratégia'), h, d); }
    else if (wkDone) { r.style.background = '#3F4A5A'; const h = el('p','serif','Nenhum “sim”'); h.style.cssText='font-size:32px;font-weight:700'; const d = el('p',null,'Volte ao grão: talvez a pergunta de negócio ainda não esteja clara. Converse com quem consome.'); d.style.fontSize='17px'; r.append(h,d); }
    else { r.style.background = '#3F4A5A'; const h = el('p','serif',Q[wkIdx].q); h.style.cssText='font-size:28px;line-height:1.25'; const d = el('p',null,'A sala responde: Sim ou Não?'); d.style.cssText='font-size:16px;opacity:.85'; r.append(lab(`Pergunta ${wkIdx+1} de 5`), h, d); }
    $('wkYes').disabled = wkDone; $('wkNo').disabled = wkDone;
  }
  $('wkYes').onclick = ()=>{ if (!wkDone) { wkDone = true; wkRender(); } };
  $('wkNo').onclick = ()=>{ if (wkDone) return; wkIdx++; if (wkIdx >= Q.length) wkDone = true; wkRender(); };
  $('wkReset').onclick = ()=>{ wkIdx = 0; wkDone = false; wkRender(); };
  (function(){ const box = $('wkCases'); box.append(el('span','small','Testar com:')); CASES.forEach(c=>{ const b = el('button','chip',c); b.type='button'; b.onclick = ()=>{ box.querySelectorAll('.chip').forEach(x=>x.classList.remove('on')); b.classList.add('on'); wkIdx=0; wkDone=false; wkRender(); }; box.append(b); }); })();
  wkRender();

  /* ─── Régua ─── */
  const base = new Date(2026,6,1);
  const fmt = d=>String(d.getDate()).padStart(2,'0')+'/'+String(d.getMonth()+1).padStart(2,'0');
  const iso = d=>`2026-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const DEF = [{id:'d1',from:new Date(2026,6,1),to:new Date(2026,7,1),v:'v1',p:5,m:150},{id:'d2',from:new Date(2026,7,1),to:new Date(2026,9,1),v:'v2',p:3,m:100},{id:'d3',from:new Date(2026,9,1),to:null,v:'v3',p:3,m:50}];
  const SPEC = {id:'s1',from:new Date(2026,8,1),to:null,v:'v1',p:10,m:300};
  const inWin = (d,r)=> d>=r.from && (!r.to || d<r.to);
  function rgRender(){
    const rg = $('rgDate'), sp = $('rgSpec'), tl = $('tl');
    const d = new Date(base); d.setDate(d.getDate()+parseInt(rg.value,10));
    const def = DEF.find(r=>inWin(d,r)); const spec = sp.checked && inWin(d,SPEC) ? SPEC : null;
    tl.querySelectorAll('.seg').forEach(s=>s.classList.remove('active','off'));
    tl.querySelector('[data-seg="s1"]').classList.toggle('off', !sp.checked);
    const applied = spec || def;
    tl.querySelector(`[data-seg="${applied.id}"]`).classList.add('active');
    const ms = tl.querySelectorAll('.m'); const first = ms[1].offsetLeft, last = ms[4].offsetLeft + ms[4].offsetWidth;
    $('cursor').style.left = (first + (last-first) * (parseInt(rg.value,10)/123)) + 'px';
    $('cursorLab').textContent = fmt(d);
    $('rgTitle').textContent = 'Régua aplicada em ' + fmt(d);
    $('rgRule').textContent = `${applied.p} dias E R$ ${applied.m}`;
    $('rgWhy').textContent = spec ? `A específica prevalece. Sem ela, valeria a default ${def.v}: ${def.p} dias E R$ ${def.m}.` : `Sem exceção vigente para o CPF, vale a default ${def.v}.`;
    const q = iso(d);
    $('rgSql').innerHTML =
`<span class="k">select</span> *
<span class="k">from</span> dim_regra_${spec?'especifica':'default'}_bloqueio_global_credito
<span class="k">where</span> ${spec?'nk_documento_nacional = <span class="s">:cpf</span>':'nm_produto = <span class="s">\'FINANCED_PURCHASE\'</span>'}
  <span class="k">and</span> <span class="s">'${q}'</span> >= ts_inicio_vigencia
  <span class="k">and</span> <span class="s">'${q}'</span> <  <span class="k">coalesce</span>(ts_fim_vigencia, <span class="s">'9999-12-31'</span>)`;
  }
  $('rgDate').addEventListener('input', rgRender); $('rgSpec').addEventListener('change', rgRender);

  /* ─── Motor ─── */
  const H = [{h:'08h',s:'Liberado',t:'—'},{h:'09h',s:'Liberado',t:'—'},{h:'10h',s:'Bloqueado',t:'002'},{h:'11h',s:'Bloqueado',t:'002'},{h:'12h',s:'Bloqueado',t:'002'},{h:'13h',s:'Liberado',t:'—'},{h:'14h',s:'Liberado',t:'—'},{h:'15h',s:'Liberado',t:'—'}];
  let hi = 0, rows = 0;
  function hrInit(){ hi=0; rows=0; const box = $('hours'); box.replaceChildren(); H.forEach(x=>{ const d = el('div','hour'); d.append(el('span','h',x.h), el('span','st','?'), el('span','mono small',' '), el('span','act',' ')); box.append(d); }); hrCount(); }
  function hrCount(){ $('cExec').textContent = hi; $('cRows').textContent = rows; }
  function hrStep(){
    if (hi >= H.length) return;
    const naive = $('hrNaive').checked, d = $('hours').children[hi], x = H[hi];
    const changed = hi===0 || H[hi-1].s !== x.s, write = naive || changed;
    d.classList.add('done', write ? 'write' : 'skip');
    d.querySelector('.st').textContent = x.s; d.querySelector('.mono').textContent = 'token ' + x.t;
    const a = d.querySelector('.act'); a.textContent = write ? (changed ? 'grava' : 'grava sem mudança') : 'ignora'; a.style.color = write ? (changed ? '#164F3C' : '#A8552F') : '#5A6472';
    if (write) rows++; hi++; hrCount();
  }
  $('hrNext').onclick = hrStep; $('hrAll').onclick = ()=>{ while (hi < H.length) hrStep(); };
  $('hrReset').onclick = hrInit; $('hrNaive').onchange = hrInit; hrInit();

  /* ─── Dinâmica ─── */
  function dnRender(){
    const di = Math.max(0, Math.min(DN.length-1, palco.dn|0)), pid = 'dn'+di, x = DN[di], rev = revealed(pid);
    $('dnNum').textContent = `Caso ${di+1} de ${DN.length}`;
    $('dnCase').textContent = x.c; $('dnHint').textContent = 'Dica: ' + x.h;
    const c = tally(pid), tot = c.reduce((a,b)=>a+b,0);
    const g = $('dnVotes'); g.replaceChildren();
    OPTS.forEach((o,i)=>{
      const b = el('button','vote' + (rev && i===x.a ? ' correct' : '')); b.type='button';
      const f = el('span','vf'); if (rev && tot) f.style.width = (c[i]/tot*100)+'%';
      b.append(el('span','vn',o), el('span','vc', rev || !live ? String(c[i]) : '·'), f);
      b.onclick = ()=>{ if (!live) { (manual[pid] = manual[pid] || Array(OPTS.length).fill(0))[i]++; renderAll(); } };
      g.append(b);
    });
    $('dnWhy').textContent = x.w; $('dnAns').classList.toggle('show', rev);
    $('dnTotal').textContent = live ? `${tot} voto${tot===1?'':'s'} recebido${tot===1?'':'s'}` : 'offline: clique nas opções para contar mãos';
    const dots = $('dnDots'); dots.replaceChildren(); DN.forEach((_,i)=>{ const d = el('i'); if (i<=di) d.className='on'; dots.append(d); });
    $('dnPrev').disabled = di===0; $('dnNext').disabled = di===DN.length-1;
  }
  $('dnReveal').onclick = ()=>revealPoll('dn' + (palco.dn|0));
  $('dnNext').onclick = ()=>{ if ((palco.dn|0) < DN.length-1) { palco.dn = (palco.dn|0)+1; pushPalco(); renderAll(); } };
  $('dnPrev').onclick = ()=>{ if ((palco.dn|0) > 0) { palco.dn = (palco.dn|0)-1; pushPalco(); renderAll(); } };
  let left = 600, tick = null; const tEl = $('timer');
  const tShow = ()=>{ tEl.textContent = String(Math.floor(left/60)).padStart(2,'0')+':'+String(left%60).padStart(2,'0'); tEl.classList.toggle('warn', left<=120); };
  tEl.onclick = ()=>{ if (tick) { clearInterval(tick); tick=null; } else { if (left<=0) left=600; tick = setInterval(()=>{ left--; tShow(); if (left<=0) { clearInterval(tick); tick=null; } }, 1000); } };
  tShow();

  /* ─── Painel de perguntas ─── */
  let qaTab = 'pergunta';
  function toggleQa(){ $('qa').hidden = !$('qa').hidden; if (!$('qa').hidden) renderQa(); }
  document.querySelectorAll('[data-qtab]').forEach(b=>b.addEventListener('click', ()=>{ qaTab = b.dataset.qtab; document.querySelectorAll('[data-qtab]').forEach(x=>x.classList.toggle('on', x===b)); renderQa(); }));
  function renderQa(){
    const all = questions();
    const pend = all.filter(q=>q.tipo==='pergunta' && !q.done);
    $('hudQ').textContent = pend.length ? `· ${pend.length}` : '';
    $('bQa').classList.toggle('hot', pend.length > 0);
    $('rodadaCount').textContent = all.filter(q=>q.tipo==='rodada').length;
    if ($('qa').hidden) return;
    const list = (qaTab === 'respondidas' ? all.filter(q=>q.done) : all.filter(q=>q.tipo===qaTab && !q.done)).sort((a,b)=> (b.likes-a.likes) || (a.ts-b.ts));
    const box = $('qaList'); box.replaceChildren();
    if (!list.length) { box.append(el('p','qa-empty', qaTab==='rodada' ? 'As respostas da rodada final aparecem aqui.' : (qaTab==='respondidas' ? 'Nada marcado como respondido ainda.' : 'Nenhuma pergunta pendente. Elas chegam pelo celular da plateia.'))); return; }
    list.forEach(q=>{
      const it = el('div','qa-item' + (q.done?' done':''));
      it.append(el('p','t',q.texto));
      it.append(el('p','m', q.anon ? 'Sem nome' : (q.nome || 'Sem nome informado')));
      it.append(el('p','n','♥ ' + q.likes));
      if (editor) { const b = el('button',null, q.done ? 'Reabrir' : 'Marcar como respondida'); b.type='button'; b.onclick = ()=>markDone(q.id, !q.done); it.append(b); }
      box.append(it);
    });
  }
  async function markDone(id, val){
    const q = (S.perguntas || []).find(x=>String(x.id)===id); if (q) q.done = val; renderAll();
    try { await api('PUT', '/api/admin/perguntas/' + encodeURIComponent(id) + '/respondida', {respondida: val}, true); } catch(e){ if (e.status === 401) needLogin(); }
  }

  /* ─── Login da apresentadora ─── */
  function needLogin(){ editor = false; adminToken = null; store.del('meetup_admin'); $('login').hidden = false; $('palco').hidden = true; setTimeout(()=>$('loginSenha').focus(), 50); }
  $('loginForm').addEventListener('submit', async e=>{
    e.preventDefault();
    $('loginErr').hidden = true; $('loginBtn').disabled = true;
    try {
      const r = await api('POST', '/api/admin/login', {senha: $('loginSenha').value});
      adminToken = r.token; store.set('meetup_admin', r.token); editor = true;
      $('loginSenha').value = ''; $('login').hidden = true; setMode('palco');
    } catch(err) {
      $('loginErr').textContent = err.code === 'muitos_envios' ? 'Muitas tentativas. Espere um minuto.' : 'Senha incorreta.';
      $('loginErr').hidden = false;
    } finally { $('loginBtn').disabled = false; }
  });

  /* ─── Modo e render ─── */
  function setMode(m){
    mode = m;
    $('plateia').hidden = m !== 'plateia';
    $('palco').hidden = m !== 'palco';
    document.body.classList.toggle('is-palco', m === 'palco');
    if (m === 'palco') { palcoSynced = false; palco = {slide:S.palco.slide|0, dn:S.palco.dn|0, rev:Object.assign({}, S.palco.rev || {})}; if (live) palcoSynced = true; fit(); go(palco.slide, false); }
    renderAll();
  }
  function renderAll(){
    if (mode === 'palco') {
      if (!$('palco').hidden) { renderStagePolls(); dnRender(); renderQa(); }
      $('capaStats').textContent = live ? `${S.votantes|0} pessoa${(S.votantes|0)===1?'':'s'} já votou${(S.votantes|0)===1?'':'aram'} · ${Math.max(0,(S.conectados|0)-1)} conectada${(S.conectados|0)-1===1?'':'s'}` : 'Conectando ao servidor…';
    } else renderAudience();
    $('audLive').classList.toggle('on', live); $('audStatus').textContent = live ? 'Ao vivo' : 'Conectando…';
    $('hudLive').classList.toggle('on', live); $('hudLiveTxt').textContent = live ? 'ao vivo' : 'offline';
  }

  /* ─── Conexão ─── */
  fetch('/api/config').then(r=>r.json()).then(c=>{ if (c && c.url) $('qrUrl').textContent = String(c.url).replace(/^https?:\/\//,''); }).catch(()=>{});

  function onState(next){
    if (!isObj(next)) return;
    S = {palco: isObj(next.palco) ? next.palco : {slide:0,dn:0,rev:{}}, tallies: isObj(next.tallies) ? next.tallies : {}, perguntas: Array.isArray(next.perguntas) ? next.perguntas : [], votantes: next.votantes|0, conectados: next.conectados|0};
    live = true;
    if (mode === 'palco' && editor) {
      // a apresentadora é a única que muda o palco: depois da 1ª sincronização, o estado local manda
      if (!palcoSynced) { palcoSynced = true; palco = {slide:S.palco.slide|0, dn:S.palco.dn|0, rev:Object.assign({}, S.palco.rev || {})}; go(palco.slide, false); }
    } else {
      palco = {slide:S.palco.slide|0, dn:S.palco.dn|0, rev:Object.assign({}, S.palco.rev || {})};
    }
    renderAll();
  }
  function connect(){
    let es;
    try { es = new EventSource('/api/eventos'); } catch(e){ setTimeout(connect, 3000); return; }
    es.addEventListener('estado', ev=>{ try { onState(JSON.parse(ev.data)); } catch(e){} });
    es.onerror = ()=>{ live = false; renderAll(); };
  }

  renderAll();
  if (IS_PALCO) {
    $('plateia').hidden = true;
    if (adminToken) api('GET', '/api/admin/check', undefined, true).then(()=>{ editor = true; setMode('palco'); }).catch(needLogin);
    else needLogin();
  } else {
    setMode('plateia');
    initParticipante();
  }
  connect();
})();
