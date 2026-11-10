'use strict';
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* 无存储也能玩 */ } },
};
const SUIT = { s: '♠', h: '♥', c: '♣', d: '♦' };
const NUM = [null, 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const ROLE = { lord: '主公', loyal: '忠臣', rebel: '反贼', traitor: '内奸' };
const TYPE = { basic: '基本', trick: '计策', delay: '延时', equip: '装备' };

let ws, token = store.get('fy-token'), defs = {}, room = null, st = null, sel = null, lastReq = 0;

function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
  ws.onopen = () => tx({ t: 'hello', token, name: $('#name').value || '玩家' });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === 'hello') { token = m.token; store.set('fy-token', token); defs = m.cards; }
    else if (m.t === 'room') { room = m.room; if (!room || !room.started) st = null; render(); }
    else if (m.t === 'state') {
      st = m;
      const id = m.req ? m.req.reqId : 0;
      if (id !== lastReq) { sel = null; lastReq = id; }
      render();
    } else if (m.t === 'error') { $('#err').textContent = m.msg; }
  };
  ws.onclose = () => setTimeout(connect, 1500);
}
const tx = (m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
const answer = (ans) => { tx({ t: 'answer', reqId: st.req.reqId, ans }); st.req = null; sel = null; render(); };

// ---------- 大厅 ----------
$('#name').value = store.get('fy-name') || '';
const hello = () => { store.set('fy-name', $('#name').value); tx({ t: 'hello', token, name: $('#name').value || '玩家' }); };
document.querySelectorAll('[data-create]').forEach((b) => b.onclick = () => { $('#err').textContent = ''; hello(); tx({ t: 'create', size: +b.dataset.create }); });
$('#join').onclick = () => { $('#err').textContent = ''; hello(); tx({ t: 'join', code: $('#code').value }); };
document.querySelectorAll('[data-size]').forEach((b) => b.onclick = () => tx({ t: 'size', size: +b.dataset.size }));
$('#start').onclick = () => tx({ t: 'start' });
$('#leave').onclick = () => tx({ t: 'leave' });
$('#logBtn').onclick = () => { $('#log').classList.toggle('full'); };

function renderLobby() {
  $('#entry').classList.toggle('hidden', !!room);
  $('#room').classList.toggle('hidden', !room);
  if (!room) return;
  $('#roomCode').textContent = room.code;
  document.querySelectorAll('[data-size]').forEach((b) => {
    b.classList.toggle('on', +b.dataset.size === room.size);
    b.disabled = !room.isHost;
  });
  const rows = room.members.map((m) => `<li>${esc(m.name)}${m.host ? '（房主）' : ''}</li>`);
  for (let i = room.members.length; i < room.size; i++) rows.push('<li class="ai">空位（开局时由电脑补齐）</li>');
  $('#members').innerHTML = rows.join('');
  $('#start').disabled = !room.isHost;
  $('#start').textContent = room.isHost ? `开始 ${room.size} 人局` : '等待房主开始';
}

// ---------- 对局 ----------
const cardTip = (c) => `<b>${esc(c.cn)}</b> ${SUIT[c.suit]}${NUM[c.num]}<br>${esc((defs[c.name] || {}).desc || '')}`;
const heroTip = (h) => h.skills.map((s) => `<b>${esc(s.name)}</b>：${esc(s.desc)}`).join('<br>');
const curOpt = () => (sel && st.req && st.req.kind === 'play' ? st.req.options[sel.i] : null);

function render() {
  const inGame = !!(room && room.started && st);
  $('#lobby').classList.toggle('hidden', inGame);
  $('#game').classList.toggle('hidden', !inGame);
  if (!inGame) { renderLobby(); return; }
  const v = st.view, req = st.req, me = v.players.find((p) => p.id === v.me);
  const byId = Object.fromEntries(v.players.map((p) => [p.id, p]));
  $('#info').textContent = `房间 ${room.code} · ${v.size}人局 · 牌堆 ${v.deck} · 第 ${v.turnNo} 回合`;

  // 座位
  const opt = curOpt();
  const n = v.players.length;
  $('#seats').innerHTML = v.players.map((p) => {
    const i = (p.seat - me.seat + n) % n;
    const th = Math.PI / 2 - (2 * Math.PI * i) / n;
    const x = 50 + (window.innerWidth < 640 ? 36 : 42) * Math.cos(th), y = 50 + 39 * Math.sin(th);
    const can = opt && opt.targets.includes(p.id);
    const cls = ['seat', p.id === v.current ? 'cur' : '', p.alive ? '' : 'dead', can ? 'can' : '', sel && sel.targets.includes(p.id) ? 'sel' : ''].join(' ');
    const hp = p.hero ? '♥'.repeat(Math.max(0, p.hp)) + `<i>${'♥'.repeat(Math.max(0, p.maxHp - Math.max(0, p.hp)))}</i>` : '';
    const eq = Object.values(p.equip).filter(Boolean);
    return `<div class="${cls}" style="left:${x}%;top:${y}%" data-pid="${esc(p.id)}">
      <span class="role ${p.role || ''}">${p.role ? ROLE[p.role] : '？'}</span>
      <div class="hn ${p.hero ? 'k' + p.hero.kingdom : ''}" ${p.hero ? `data-tip="${esc(heroTip(p.hero))}"` : ''}>${p.hero ? esc(p.hero.name) : '选将中'}</div>
      <div class="pn">${esc(p.name)}${p.id === v.me ? '（你）' : ''}</div>
      <div class="hp">${hp}</div>
      <div>手牌 ${p.handCount}</div>
      ${eq.length ? `<div class="eq">${eq.map((c) => `<span data-tip="${esc(cardTip(c))}">${esc(c.cn)}</span>`).join(' ')}</div>` : ''}
      ${p.judge.length ? `<div class="jd">${p.judge.map((c) => `⚑${esc(c.cn)}`).join(' ')}</div>` : ''}
      ${st.waiting.includes(p.id) ? '<span class="think">…</span>' : ''}
    </div>`;
  }).join('');

  // 战报
  const log = $('#log');
  log.innerHTML = st.log.map((l) => `<div>${esc(l)}</div>`).join('');
  log.scrollTop = log.scrollHeight;

  // 自己
  $('#me').innerHTML = `<span>身份：<b>${ROLE[me.role] || ''}</b></span>` + (me.hero
    ? `<span class="k${me.hero.kingdom}"><b>${esc(me.hero.name)}</b></span><span>体力 ${me.hp}/${me.maxHp}</span>`
      + me.hero.skills.map((s) => `<span class="sk" data-tip="${esc(`<b>${esc(s.name)}</b>：${esc(s.desc)}`)}">${esc(s.name)}</span>`).join('')
    : '');

  // 提示
  let prompt = '';
  if (req) prompt = req.prompt || '';
  else if (!v.over) {
    const names = st.waiting.map((id) => byId[id]).filter(Boolean).map((p) => (p.hero ? p.hero.name : p.name));
    prompt = names.length ? `等待 ${names.join('、')} 行动…` : '';
  }
  $('#prompt').textContent = prompt;

  renderActions(req, me);
  renderHand(req, me);
  renderOver(v);
}

function renderActions(req, me) {
  const box = $('#actions');
  box.innerHTML = '';
  const btn = (label, fn, cls, html) => {
    const b = document.createElement('button');
    if (html) b.innerHTML = html; else b.textContent = label;
    if (cls) b.className = cls;
    b.onclick = fn;
    box.appendChild(b);
    return b;
  };
  if (!req) return;
  if (req.kind === 'play') {
    const opt = curOpt();
    req.options.forEach((o, i) => {
      if (!o.skill) return;
      btn(o.label, () => { sel = sel && sel.i === i ? null : { i, cards: [], targets: [] }; render(); }, sel && sel.i === i ? 'on' : '');
    });
    if (opt) {
      const ok = sel.cards.length === opt.nCards && sel.targets.length === opt.nTargets;
      const need = [];
      if (opt.nCards) need.push(`选${opt.nCards}张牌`);
      if (opt.nTargets) need.push(`选${opt.nTargets}个目标`);
      btn(`确定${need.length && !ok ? `（${need.join('，')}）` : ''}`, () => answer({ i: sel.i, cards: sel.cards, targets: sel.targets }), 'primary').disabled = !ok;
      btn('取消', () => { sel = null; render(); });
    }
    btn('结束回合', () => answer({ end: true }));
  } else if (req.kind === 'respond') {
    btn('不出', () => answer({}));
  } else if (req.kind === 'discard') {
    const picked = sel ? sel.cards : [];
    btn(`确定（${picked.length}/${req.n}）`, () => answer({ cardIds: picked }), 'primary').disabled = picked.length !== req.n;
    if (req.optional) btn('不弃', () => answer({}));
  } else if (req.kind === 'choose') {
    req.options.forEach((o, i) => {
      if (o.hero) {
        btn('', () => answer({ i }), 'heroOpt', `<b class="k${o.hero.kingdom}">${esc(o.hero.name)}</b>（${o.hero.kingdom}·${o.hero.hp}体力）<small>${heroTip(o.hero)}</small>`);
      } else btn(o.label, () => answer({ i }));
    });
  }
}

function renderHand(req, me) {
  const box = $('#hand');
  box.innerHTML = '';
  const opt = curOpt();
  for (const c of me.hand || []) {
    let can = false, picked = false, click = null;
    if (req && req.kind === 'play') {
      if (opt && opt.skill) {
        can = opt.pickCards.includes(c.id);
        picked = sel.cards.includes(c.id);
        click = () => {
          if (picked) sel.cards = sel.cards.filter((x) => x !== c.id);
          else { if (sel.cards.length >= opt.nCards) sel.cards.shift(); sel.cards.push(c.id); }
          render();
        };
      } else {
        const i = req.options.findIndex((o) => o.cardId === c.id);
        can = i >= 0;
        picked = !!sel && sel.i === i;
        click = () => { sel = picked ? null : { i, cards: [], targets: [] }; render(); };
      }
    } else if (req && req.kind === 'respond') {
      can = req.cards.includes(c.id);
      click = () => answer({ cardId: c.id });
    } else if (req && req.kind === 'discard') {
      can = req.cards.includes(c.id);
      picked = !!sel && sel.cards.includes(c.id);
      click = () => {
        if (!sel) sel = { cards: [], targets: [] };
        if (picked) sel.cards = sel.cards.filter((x) => x !== c.id);
        else { if (sel.cards.length >= req.n) sel.cards.shift(); sel.cards.push(c.id); }
        render();
      };
    }
    const el = document.createElement('div');
    el.className = `card ${c.suit === 'h' || c.suit === 'd' ? 'red' : ''} ${can ? 'can' : req ? 'dim' : ''} ${picked ? 'sel' : ''}`;
    el.dataset.tip = cardTip(c);
    el.innerHTML = `<span class="st">${SUIT[c.suit]}${NUM[c.num]}</span><div class="nm">${esc(c.cn)}</div><span class="tp">${TYPE[c.type]}</span>`;
    if (can && click) el.onclick = click;
    box.appendChild(el);
  }
}

function renderOver(v) {
  const box = $('#over');
  box.classList.toggle('hidden', !v.over);
  if (!v.over) return;
  const w = v.result.winner;
  const title = w === 'draw' ? `平局（${v.result.reason}）` : `${{ lord: '主公与忠臣', rebel: '反贼', traitor: '内奸' }[w]}获胜`;
  box.innerHTML = `<h2>${esc(title)}</h2><ul>${v.players.map((p) =>
    `<li><span class="role ${p.role}" style="float:none">${ROLE[p.role]}</span> ${p.hero ? esc(p.hero.name) : ''}（${esc(p.name)}）${p.alive ? '' : ' · 阵亡'}</li>`).join('')}</ul>`;
  const b = document.createElement('button');
  b.className = 'big';
  b.textContent = room.isHost ? '返回房间，再来一局' : '等待房主…';
  b.disabled = !room.isHost;
  b.onclick = () => tx({ t: 'again' });
  box.appendChild(b);
}

// 点选目标
$('#seats').addEventListener('click', (e) => {
  const seat = e.target.closest('.seat');
  const opt = st && curOpt();
  if (!seat || !opt || !opt.targets.includes(seat.dataset.pid)) return;
  const id = seat.dataset.pid;
  if (sel.targets.includes(id)) sel.targets = sel.targets.filter((x) => x !== id);
  else { if (sel.targets.length >= opt.nTargets) sel.targets.shift(); sel.targets.push(id); }
  render();
});

// 悬浮说明
const tip = $('#tip');
document.addEventListener('mouseover', (e) => {
  const el = e.target.closest('[data-tip]');
  if (!el) { tip.classList.add('hidden'); return; }
  tip.innerHTML = el.dataset.tip;
  tip.classList.remove('hidden');
  const r = el.getBoundingClientRect();
  tip.style.left = `${Math.max(8, Math.min(window.innerWidth - 270, r.left))}px`;
  const below = r.top < 160;
  tip.style.top = below ? `${r.bottom + 6}px` : '';
  tip.style.bottom = below ? '' : `${window.innerHeight - r.top + 6}px`;
});

connect();
