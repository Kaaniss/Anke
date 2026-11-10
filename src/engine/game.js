// 规则引擎：纯逻辑，不依赖网络与界面。
// 所有需要玩家决策的地方都通过 io.ask(pid, req) 挂起等待，真人、AI、超时托管走同一个口子。
import { buildDeck, cardText, isRed, isBlack, CARDS } from './cards.js';
import { HEROES, SKILLS, heroInfo } from './heroes.js';

export class GameOver extends Error {
  constructor(result) { super('gameover'); this.result = result; }
}

export const ROLE_SETS = {
  5: ['lord', 'loyal', 'rebel', 'rebel', 'traitor'],
  6: ['lord', 'loyal', 'rebel', 'rebel', 'rebel', 'traitor'],
  7: ['lord', 'loyal', 'loyal', 'rebel', 'rebel', 'rebel', 'traitor'],
  8: ['lord', 'loyal', 'loyal', 'rebel', 'rebel', 'rebel', 'rebel', 'traitor'],
};
export const ROLE_CN = { lord: '主公', loyal: '忠臣', rebel: '反贼', traitor: '内奸' };
const HARMFUL_TRICKS = new Set(['snatch', 'dismantle', 'duel', 'volley', 'charge']);
const MAX_TURNS = 400;

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Game {
  constructor({ players, io, seed = Date.now() }) {
    if (!ROLE_SETS[players.length]) throw new Error('仅支持 5~8 人');
    this.rng = mulberry32(seed);
    this.io = io;
    this.size = players.length;
    this.players = players.map((p, i) => ({
      id: p.id, name: p.name, isAI: !!p.ai, seat: i, role: null, hero: null, skills: [],
      hp: 0, maxHp: 0, hand: [], equip: { weapon: null, armor: null, plus: null, minus: null },
      judge: [], alive: true, turn: { slash: 0, used: {} },
    }));
    this.byId = Object.fromEntries(this.players.map((p) => [p.id, p]));
    this.deck = this.shuffle(buildDeck());
    this.discardPile = [];
    this.logs = [];
    this.turnNo = 0;
    this.current = null;
    this.over = false;
    this.result = null;
    this.harmM = {}; this.helpM = {};
    for (const p of this.players) { this.harmM[p.id] = {}; this.helpM[p.id] = {}; }
  }

  // ---------- 基础工具 ----------
  shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  log(text) { this.logs.push(text); this.io.update?.(); }
  nm(p) { return p.hero ? `${p.hero.name}(${p.name})` : p.name; }
  ids(list) { return list.map((x) => x.id); }
  alive() { return this.players.filter((p) => p.alive); }
  others(p) { return this.players.filter((q) => q.alive && q !== p); }
  equips(p) { return Object.values(p.equip).filter(Boolean); }
  hasCards(p) { return p.hand.length + this.equips(p).length + p.judge.length > 0; }
  hasSkill(p, key) { return p.skills.some((s) => s.key === key); }
  take(arr, card) { const i = arr.indexOf(card); if (i >= 0) arr.splice(i, 1); return card; }
  nextAlive(p) {
    for (let i = 1; i <= this.size; i++) {
      const q = this.players[(p.seat + i) % this.size];
      if (q.alive) return q;
    }
    return p;
  }
  orderFrom(p) {
    const out = [];
    for (let i = 0; i < this.size; i++) {
      const q = this.players[(p.seat + i) % this.size];
      if (q.alive) out.push(q);
    }
    return out;
  }
  harm(a, b) { if (a !== b) this.harmM[a.id][b.id] = (this.harmM[a.id][b.id] || 0) + 1; }
  help(a, b) { if (a !== b) this.helpM[a.id][b.id] = (this.helpM[a.id][b.id] || 0) + 1; }

  async hook(p, name, ...args) {
    for (const s of p.skills) if (typeof s[name] === 'function') await s[name](this, p, ...args);
  }
  mod(p, name, base, ...args) {
    for (const s of p.skills) if (typeof s[name] === 'function') base = s[name](this, p, base, ...args);
    return base;
  }

  dist(a, b) {
    const al = this.alive();
    const ia = al.indexOf(a), ib = al.indexOf(b);
    let d = Math.abs(ia - ib);
    d = Math.min(d, al.length - d);
    if (b.equip.plus) d += 1;
    if (a.equip.minus) d -= 1;
    d = this.mod(a, 'distTo', d, b);
    return Math.max(1, d);
  }
  range(p) { return this.mod(p, 'range', p.equip.weapon ? p.equip.weapon.range : 1); }

  // ---------- 牌堆 ----------
  refill() {
    if (this.deck.length) return;
    if (!this.discardPile.length) throw new GameOver({ winner: 'draw', reason: '牌堆耗尽' });
    this.deck = this.shuffle(this.discardPile);
    this.discardPile = [];
  }
  peek() { this.refill(); return this.deck[this.deck.length - 1]; }
  drawTop() { this.refill(); return this.deck.pop(); }
  draw(p, n) {
    for (let i = 0; i < n; i++) p.hand.push(this.drawTop());
    this.io.update?.();
  }
  judge(p, reason) {
    const c = this.drawTop();
    this.discardPile.push(c);
    this.log(`${this.nm(p)} 的〔${reason}〕判定结果为 ${cardText(c)}`);
    return c;
  }
  takeRandomHand(p) {
    return p.hand.splice(Math.floor(this.rng() * p.hand.length), 1)[0];
  }
  discardFromHand(p, cards) {
    for (const c of cards) { this.take(p.hand, c); this.discardPile.push(c); }
  }
  async lostHand(p) { if (p.alive && this.current !== p) await this.hook(p, 'lostHand'); }

  // ---------- 询问 ----------
  async ask(p, req) {
    try { return await this.io.ask(p.id, req); } catch { return null; }
  }
  async choose(p, options, prompt, extra = {}) {
    const ans = await this.ask(p, { kind: 'choose', options, prompt, ...extra });
    const i = ans && Number.isInteger(ans.i) ? ans.i : -1;
    return i >= 0 && i < options.length ? i : (extra.def ?? 0);
  }
  async confirm(p, prompt, aiYes = true) {
    return (await this.choose(p, [{ label: '发动' }, { label: '取消' }], prompt, { confirm: true, aiYes, def: 1 })) === 0;
  }
  async choosePlayer(p, list, prompt, { aim, optional } = {}) {
    if (!list.length) return null;
    const options = list.map((q) => ({ label: this.nm(q), pid: q.id }));
    if (optional) options.push({ label: '取消' });
    const i = await this.choose(p, options, prompt, { playerChoice: true, aim, optional: !!optional, def: options.length - 1 });
    return options[i].pid ? this.byId[options[i].pid] : null;
  }
  // 要求打出一张指定牌名的手牌；返回打出的牌或 null
  async askRespond(p, want, ctx, prompt) {
    const cards = p.hand.filter((c) => c.name === want);
    if (!cards.length) return null;
    const ans = await this.ask(p, { kind: 'respond', want, cards: this.ids(cards), ctx, prompt });
    const c = ans && cards.find((x) => x.id === ans.cardId);
    if (!c) return null;
    this.take(p.hand, c); this.discardPile.push(c);
    this.log(`${this.nm(p)} 打出 ${cardText(c)}`);
    return c;
  }
  // 弃置 n 张手牌；optional 时可拒绝（返回 null）
  async askDiscard(p, n, { optional = false, filter = null, prompt = '', ai = null } = {}) {
    const pool = filter ? p.hand.filter(filter) : [...p.hand];
    if (pool.length < n) { if (optional) return null; n = pool.length; }
    if (n <= 0) return [];
    const ans = await this.ask(p, { kind: 'discard', n, cards: this.ids(pool), optional, prompt: prompt || `请弃置 ${n} 张手牌`, ai });
    let chosen = null;
    if (ans && Array.isArray(ans.cardIds)) {
      const set = [...new Set(ans.cardIds)];
      const cs = set.map((id) => pool.find((c) => c.id === id));
      if (set.length === n && cs.every(Boolean)) chosen = cs;
    }
    if (!chosen) { if (optional) return null; chosen = pool.slice(-n); }
    this.discardFromHand(p, chosen);
    this.log(`${this.nm(p)} 弃置了 ${chosen.map(cardText).join('')}`);
    return chosen;
  }
  // src 从 tgt 的区域里选一张牌并移出，返回 {card, zone}
  async pickFrom(src, tgt, prompt, { equipOnly = false } = {}) {
    const options = [];
    if (!equipOnly && tgt.hand.length) options.push({ label: `手牌（${tgt.hand.length}张，随机）`, zone: 'hand' });
    for (const c of this.equips(tgt)) options.push({ label: `装备 ${cardText(c)}`, zone: 'equip', cardId: c.id });
    if (!equipOnly) for (const c of tgt.judge) options.push({ label: `判定区 ${cardText(c)}`, zone: 'judge', cardId: c.id });
    if (!options.length) return null;
    const o = options[await this.choose(src, options, prompt, { pick: true, tgt: tgt.id })];
    let card;
    if (o.zone === 'hand') {
      card = this.takeRandomHand(tgt);
    } else if (o.zone === 'equip') {
      card = this.equips(tgt).find((c) => c.id === o.cardId);
      tgt.equip[card.sub] = null;
    } else {
      card = this.take(tgt.judge, tgt.judge.find((c) => c.id === o.cardId));
    }
    return { card, zone: o.zone };
  }

  // 计策生效前的抵消流程；返回 true 表示被抵消
  async negated(name, src, tgt) {
    if (tgt && src && tgt !== src && HARMFUL_TRICKS.has(name)) {
      for (const s of tgt.skills) {
        if (s.trickTarget && await s.trickTarget(this, tgt, name, src)) {
          this.log(`${CARDS[name].cn} 对 ${this.nm(tgt)} 无效`);
          return true;
        }
      }
    }
    return this.askNegate(name, src, tgt, 0);
  }
  async askNegate(name, src, tgt, depth) {
    const start = this.current && this.current.alive ? this.current : this.alive()[0];
    for (const q of this.orderFrom(start)) {
      const what = depth % 2 ? '【破计】' : `【${CARDS[name].cn}】`;
      const c = await this.askRespond(q, 'negate',
        { trick: name, src: src ? src.id : null, tgt: tgt ? tgt.id : null, depth },
        `是否打出【破计】抵消${what}${tgt ? `（目标：${this.nm(tgt)}）` : ''}？`);
      if (!c) continue;
      if (await this.askNegate(name, src, tgt, depth + 1)) return false;
      if (depth === 0) this.log(`【${CARDS[name].cn}】${tgt ? `对 ${this.nm(tgt)} ` : ''}被抵消`);
      return true;
    }
    return false;
  }

  // ---------- 流程 ----------
  async run() {
    try {
      await this.setup();
      let p = this.lord;
      for (;;) {
        await this.turn(p);
        p = this.nextAlive(p);
      }
    } catch (e) {
      if (!(e instanceof GameOver)) throw e;
      this.over = true;
      this.result = e.result;
      const w = e.result.winner;
      this.log(w === 'draw' ? `平局（${e.result.reason}）`
        : `游戏结束：${{ lord: '主公与忠臣', rebel: '反贼', traitor: '内奸' }[w]}获胜！`);
      return e.result;
    }
  }

  async setup() {
    const roles = this.shuffle([...ROLE_SETS[this.size]]);
    this.players.forEach((p, i) => { p.role = roles[i]; });
    this.lord = this.players.find((p) => p.role === 'lord');
    this.log(`${this.size}人局开始，${this.lord.name} 是主公`);
    const pool = this.shuffle([...HEROES]);
    const pick = async (p, n) => {
      const opts = pool.splice(0, n);
      const i = await this.choose(p, opts.map((h) => ({ label: h.name, hero: heroInfo(h) })),
        `请选择武将（你的身份：${ROLE_CN[p.role]}）`, { heroChoice: true });
      const h = opts[i];
      p.hero = heroInfo(h);
      p.skills = h.skills.map((k) => ({ key: k, ...SKILLS[k] }));
      p.maxHp = h.hp + (p.role === 'lord' ? 1 : 0);
      p.hp = p.maxHp;
    };
    await pick(this.lord, 5);
    this.log(`主公选择了 ${this.lord.hero.name}`);
    const rest = this.others(this.lord);
    const each = Math.max(1, Math.min(3, Math.floor(pool.length / rest.length)));
    await Promise.all(rest.map((p) => pick(p, each)));
    for (const p of this.orderFrom(this.lord)) this.draw(p, 4);
  }

  async turn(p) {
    if (++this.turnNo > MAX_TURNS) throw new GameOver({ winner: 'draw', reason: '回合数达到上限' });
    this.current = p;
    p.turn = { slash: 0, used: {} };
    this.log(`—— ${this.nm(p)} 的回合 ——`);
    await this.hook(p, 'turnStart');
    // 判定阶段
    for (const c of [...p.judge].reverse()) {
      if (!p.alive) return;
      if (!p.judge.includes(c)) continue;
      this.take(p.judge, c);
      await this.resolveDelay(p, c);
    }
    if (!p.alive) return;
    // 摸牌阶段
    this.draw(p, this.mod(p, 'drawCount', 2));
    // 出牌阶段
    if (p.turn.skipPlay) this.log(`${this.nm(p)} 跳过出牌阶段`);
    else await this.playPhase(p);
    if (!p.alive) return;
    // 弃牌阶段
    const limit = Math.max(0, this.mod(p, 'handLimit', p.hp));
    if (p.hand.length > limit) await this.askDiscard(p, p.hand.length - limit, { prompt: `弃牌阶段：请弃置 ${p.hand.length - limit} 张手牌` });
    await this.hook(p, 'turnEnd');
  }

  async resolveDelay(p, c) {
    const cancelled = await this.negated(c.name, null, p);
    if (c.name === 'trap') {
      this.discardPile.push(c);
      if (cancelled) return;
      if (this.judge(p, '困阵').suit !== 'h') p.turn.skipPlay = true;
      return;
    }
    // 天雷
    if (!cancelled) {
      const j = this.judge(p, '天雷');
      if (j.suit === 's' && j.num >= 2 && j.num <= 9) {
        this.discardPile.push(c);
        this.log(`天雷劈中了 ${this.nm(p)}！`);
        await this.damage(null, p, 3);
        return;
      }
    }
    const next = this.orderFrom(p).slice(1).find((q) => !q.judge.some((x) => x.name === 'thunder'));
    (next || p).judge.push(c);
    if (next) this.log(`【天雷】移至 ${this.nm(next)}`);
  }

  playOptions(p) {
    const opts = [];
    const others = this.others(p);
    for (const c of p.hand) {
      const o = { cardId: c.id, name: c.name, label: cardText(c), nCards: 0, nTargets: 0, targets: [] };
      switch (c.name) {
        case 'slash': {
          if (p.equip.weapon?.name !== 'crossbow' && p.turn.slash >= this.mod(p, 'slashLimit', 1)) continue;
          const free = p.skills.some((s) => s.slashAnyRange && s.slashAnyRange(this, p));
          const ts = others.filter((q) => free || this.dist(p, q) <= this.range(p));
          if (!ts.length) continue;
          o.targets = this.ids(ts); o.nTargets = 1; o.aim = 'enemy';
          break;
        }
        case 'heal':
          if (p.skills.some((s) => s.healOthers)) {
            const ts = this.alive().filter((q) => q.hp < q.maxHp);
            if (!ts.length) continue;
            o.targets = this.ids(ts); o.nTargets = 1; o.aim = 'ally';
          } else if (p.hp >= p.maxHp) continue;
          break;
        case 'snatch': {
          const ts = others.filter((q) => this.hasCards(q) && this.dist(p, q) <= 1);
          if (!ts.length) continue;
          o.targets = this.ids(ts); o.nTargets = 1; o.aim = 'enemy';
          break;
        }
        case 'dismantle': {
          const ts = others.filter((q) => this.hasCards(q));
          if (!ts.length) continue;
          o.targets = this.ids(ts); o.nTargets = 1; o.aim = 'enemy';
          break;
        }
        case 'duel':
          o.targets = this.ids(others); o.nTargets = 1; o.aim = 'enemy';
          break;
        case 'trap': {
          const ts = others.filter((q) => !q.judge.some((x) => x.name === 'trap'));
          if (!ts.length) continue;
          o.targets = this.ids(ts); o.nTargets = 1; o.aim = 'enemy';
          break;
        }
        case 'thunder':
          if (p.judge.some((x) => x.name === 'thunder')) continue;
          break;
        case 'dodge': case 'negate':
          continue;
        default: break;
      }
      opts.push(o);
    }
    for (const s of p.skills) {
      if (!s.active) continue;
      const o = s.active.option(this, p);
      if (o) opts.push({ skill: s.key, nCards: 0, nTargets: 0, targets: [], pickCards: [], ...o });
    }
    return opts;
  }

  async playPhase(p) {
    let bad = 0;
    for (let step = 0; step < 60 && p.alive; step++) {
      const options = this.playOptions(p);
      const ans = await this.ask(p, { kind: 'play', options, prompt: '出牌阶段：请出牌，或结束回合' });
      if (!ans || ans.end) return;
      const o = options[ans.i];
      const targets = Array.isArray(ans.targets) ? [...new Set(ans.targets)] : [];
      const cardIds = Array.isArray(ans.cards) ? [...new Set(ans.cards)] : [];
      const valid = o
        && targets.length === o.nTargets && targets.every((t) => o.targets.includes(t))
        && cardIds.length === o.nCards && cardIds.every((id) => o.pickCards.includes(id));
      if (!valid) { if (++bad >= 3) return; continue; }
      const tps = targets.map((id) => this.byId[id]);
      if (o.skill) {
        const s = p.skills.find((x) => x.key === o.skill);
        await s.active.run(this, p, cardIds.map((id) => p.hand.find((c) => c.id === id)), tps);
      } else {
        await this.useCard(p, p.hand.find((c) => c.id === o.cardId), tps);
      }
    }
  }

  async useCard(p, card, targets) {
    this.take(p.hand, card);
    const t = targets[0];
    this.log(`${this.nm(p)} ${card.type === 'equip' ? '装备' : '使用'} ${cardText(card)}${t ? ` → ${this.nm(t)}` : ''}`);
    let keep = false;
    try {
      switch (card.name) {
        case 'slash':
          p.turn.slash++;
          this.harm(p, t);
          await this.slash(p, t, card);
          break;
        case 'heal': {
          const who = t || p;
          this.recover(who, 1);
          this.help(p, who);
          await this.hook(p, 'afterHeal');
          break;
        }
        case 'plan':
          if (!(await this.negated('plan', p, p))) this.draw(p, 2);
          break;
        case 'feast':
          for (const q of this.orderFrom(p)) {
            if (q.alive && q.hp < q.maxHp && !(await this.negated('feast', p, q))) this.recover(q, 1);
          }
          break;
        case 'volley':
        case 'charge':
          for (const q of this.orderFrom(p)) {
            if (q === p || !q.alive || !p.alive) continue;
            if (await this.negated(card.name, p, q)) continue;
            const ok = card.name === 'volley'
              ? await this.askDodge(q, p, false)
              : await this.askRespond(q, 'slash', { from: p.id, by: 'charge' }, `【冲阵】：请打出一张【斩】，否则受到1点伤害`);
            if (!ok) await this.damage(p, q, 1);
          }
          break;
        case 'duel': {
          this.harm(p, t);
          if (await this.negated('duel', p, t)) break;
          let a = t, b = p;
          for (;;) {
            const c = await this.askRespond(a, 'slash', { from: b.id, by: 'duel' }, `【单挑】：请打出一张【斩】，否则受到1点伤害`);
            if (!c) { await this.damage(b, a, 1); break; }
            [a, b] = [b, a];
          }
          break;
        }
        case 'snatch':
        case 'dismantle': {
          if (await this.negated(card.name, p, t)) { this.harm(p, t); break; }
          const r = await this.pickFrom(p, t, `【${card.cn}】：选择 ${this.nm(t)} 的一张牌`);
          if (!r) break;
          if (r.zone === 'judge') this.help(p, t); else this.harm(p, t);
          if (card.name === 'snatch') {
            p.hand.push(r.card);
            this.log(`${this.nm(p)} 获得了 ${this.nm(t)} 的${r.zone === 'hand' ? '一张手牌' : cardText(r.card)}`);
          } else {
            this.discardPile.push(r.card);
            this.log(`${this.nm(p)} 弃置了 ${this.nm(t)} 的 ${cardText(r.card)}`);
          }
          if (r.zone === 'hand') await this.lostHand(t);
          break;
        }
        case 'trap':
          keep = true; this.harm(p, t); t.judge.push(card);
          break;
        case 'thunder':
          keep = true; p.judge.push(card);
          break;
        default:
          if (card.type === 'equip') {
            keep = true;
            const old = p.equip[card.sub];
            if (old) this.discardPile.push(old);
            p.equip[card.sub] = card;
          }
      }
    } finally {
      if (!keep) this.discardPile.push(card);
    }
    this.io.update?.();
  }

  // 要求 tgt 打出【挡】（含防具判定）；返回是否抵消
  async askDodge(tgt, src, ignoreArmor) {
    if (!ignoreArmor && tgt.equip.armor?.name === 'mystic') {
      if (isRed(this.judge(tgt, '玄甲'))) { this.log(`${this.nm(tgt)} 的【玄甲】生效`); return true; }
    }
    const c = await this.askRespond(tgt, 'dodge', { from: src.id, by: 'attack' }, `${this.nm(src)} 的攻击：请打出一张【挡】，否则受到伤害`);
    if (!c) return false;
    await this.hook(tgt, 'afterDodge');
    return true;
  }

  async slash(src, tgt, card) {
    if (!tgt.alive) return;
    const ignoreArmor = src.equip.weapon?.name === 'sword';
    const bonus = src.turn.rage ? 1 : 0;
    src.turn.rage = false;
    if (!ignoreArmor && tgt.equip.armor?.name === 'shield' && isBlack(card)) {
      this.log(`${this.nm(tgt)} 的【铁盾】使黑色【斩】无效`);
      return;
    }
    let dodged = await this.askDodge(tgt, src, ignoreArmor);
    if (dodged) {
      await this.hook(src, 'slashDodged', tgt);
      if (src.alive && tgt.alive && src.equip.weapon?.name === 'axe' && src.hand.length >= 2
        && await this.confirm(src, '开山斧：是否弃两张手牌令【斩】依然命中？', src.hand.length >= 4)) {
        await this.askDiscard(src, 2, { prompt: '开山斧：请弃置两张手牌' });
        this.log(`${this.nm(src)} 的【开山斧】强行命中`);
        dodged = false;
      }
    }
    if (dodged) return;
    await this.damage(src, tgt, 1 + bonus);
    if (!tgt.alive || !src.alive) return;
    await this.hook(src, 'slashHit', tgt);
    if (src.equip.weapon?.name === 'bow' && (tgt.equip.plus || tgt.equip.minus)
      && await this.confirm(src, `强弓：是否弃置 ${this.nm(tgt)} 的一匹坐骑？`)) {
      const sub = tgt.equip.plus ? 'plus' : 'minus';
      this.discardPile.push(tgt.equip[sub]);
      this.log(`${this.nm(src)} 的【强弓】射落了 ${cardText(tgt.equip[sub])}`);
      tgt.equip[sub] = null;
    }
  }

  recover(p, n) {
    const v = Math.min(n, p.maxHp - p.hp);
    if (v <= 0) return;
    p.hp += v;
    this.log(`${this.nm(p)} 回复${v}点体力（${p.hp}/${p.maxHp}）`);
  }

  async damage(src, tgt, n) {
    if (!tgt.alive) return;
    tgt.hp -= n;
    if (src) src.turn.dealt = true;
    this.log(`${this.nm(tgt)} 受到${src ? ` ${this.nm(src)} 造成的` : ''}${n}点伤害（${tgt.hp}/${tgt.maxHp}）`);
    if (tgt.hp <= 0) await this.dying(tgt, src);
    if (tgt.alive) await this.hook(tgt, 'damaged', src, n);
  }

  async loseHp(p, n) {
    p.hp -= n;
    if (p.hp <= 0) await this.dying(p, null);
  }

  async dying(tgt, src) {
    this.log(`${this.nm(tgt)} 进入濒死状态`);
    const start = this.current && this.current.alive ? this.current : tgt;
    for (const q of this.orderFrom(start)) {
      while (tgt.hp <= 0) {
        const c = await this.askRespond(q, 'heal', { dying: tgt.id },
          `${this.nm(tgt)} 濒死（体力${tgt.hp}），是否打出【丹】救援？`);
        if (!c) break;
        tgt.hp += 1;
        this.help(q, tgt);
        this.log(`${this.nm(tgt)} 被救回1点体力（${tgt.hp}/${tgt.maxHp}）`);
        await this.hook(q, 'afterHeal');
      }
      if (tgt.hp > 0) return;
    }
    await this.die(tgt, src);
  }

  async die(tgt, src) {
    tgt.alive = false;
    this.log(`${this.nm(tgt)} 阵亡，身份是【${ROLE_CN[tgt.role]}】`);
    this.discardPile.push(...tgt.hand, ...this.equips(tgt), ...tgt.judge);
    tgt.hand = []; tgt.judge = [];
    tgt.equip = { weapon: null, armor: null, plus: null, minus: null };
    this.checkWin();
    await this.hook(tgt, 'onDeath', src);
    for (const q of this.alive()) await this.hook(q, 'anyDeath', tgt);
    if (src && src.alive) {
      if (tgt.role === 'rebel') {
        this.log(`${this.nm(src)} 击杀反贼，摸三张牌`);
        this.draw(src, 3);
      } else if (tgt.role === 'loyal' && src.role === 'lord') {
        this.log(`主公误杀忠臣，弃置所有手牌与装备`);
        this.discardPile.push(...src.hand, ...this.equips(src));
        src.hand = [];
        src.equip = { weapon: null, armor: null, plus: null, minus: null };
      }
    }
  }

  checkWin() {
    const al = this.alive();
    if (!this.lord.alive) {
      const w = al.length === 1 && al[0].role === 'traitor' ? 'traitor' : 'rebel';
      throw new GameOver({ winner: w });
    }
    if (!al.some((p) => p.role === 'rebel' || p.role === 'traitor')) throw new GameOver({ winner: 'lord' });
  }

  // ---------- 视角过滤 ----------
  view(pid) {
    return {
      me: pid, size: this.size, turnNo: this.turnNo, current: this.current ? this.current.id : null,
      deck: this.deck.length, over: this.over, result: this.result,
      harm: this.harmM, help: this.helpM,
      players: this.players.map((p) => ({
        id: p.id, name: p.name, seat: p.seat, isAI: p.isAI, alive: p.alive, hp: p.hp, maxHp: p.maxHp,
        hero: p.hero,
        role: p.role === 'lord' || p.id === pid || !p.alive || this.over ? p.role : null,
        handCount: p.hand.length,
        hand: p.id === pid ? p.hand.map((c) => ({ ...c })) : undefined,
        equip: { ...p.equip }, judge: [...p.judge],
      })),
    };
  }
}
