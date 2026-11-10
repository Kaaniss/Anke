// 电脑 AI：只看自己视角的信息（view），和真人回答同一套询问。
import { ROLE_SETS } from '../engine/game.js';

const HARMFUL = new Set(['snatch', 'dismantle', 'duel', 'volley', 'charge', 'trap', 'thunder']);
const VALUE = { heal: 9, negate: 7, dodge: 6, plan: 6, slash: 5, snatch: 5, dismantle: 4, duel: 4, volley: 4, charge: 4, feast: 3, trap: 4, thunder: 1 };
const val = (c) => VALUE[c.name] ?? 2;

// 根据公开的敌对/援助记录推测各角色立场：>0 友方，<0 敌方，0 不明
function attitudes(v, me) {
  const lord = v.players.find((p) => p.role === 'lord');
  const H = (a, b) => (v.harm[a] && v.harm[a][b]) || 0;
  const P = (a, b) => (v.help[a] && v.help[a][b]) || 0;
  const base = {};
  for (const p of v.players) base[p.id] = p === lord ? -99 : 2 * H(p.id, lord.id) - 2 * P(p.id, lord.id);
  const score = {};
  for (const p of v.players) {
    if (p === lord) continue;
    let s = base[p.id] + 0.5 * H(lord.id, p.id);
    for (const q of v.players) {
      if (q === lord || q === p) continue;
      if (base[q.id] > 0) s -= 0.7 * H(p.id, q.id);
      else if (base[q.id] < 0) s += 0.7 * H(p.id, q.id);
    }
    score[p.id] = s;
  }
  const total = ROLE_SETS[v.size].filter((r) => r === 'rebel').length;
  const rebelsLeft = total - v.players.filter((p) => !p.alive && p.role === 'rebel').length;
  const loyalLeft = ROLE_SETS[v.size].filter((r) => r === 'loyal').length
    - v.players.filter((p) => !p.alive && p.role === 'loyal').length;
  const alive = v.players.filter((p) => p.alive);
  const att = {};
  for (const p of alive) {
    if (p.id === me.id) continue;
    const s = score[p.id];
    const looksRebel = s > 0.5, looksLoyal = s < -0.5;
    if (me.role === 'lord' || me.role === 'loyal') {
      if (p === lord) att[p.id] = 1;
      else if (rebelsLeft === 0) att[p.id] = me.role === 'loyal' ? -1 : 0;
      else att[p.id] = looksRebel ? -1 : looksLoyal ? 1 : 0;
    } else if (me.role === 'rebel') {
      att[p.id] = p === lord ? -1 : looksRebel ? 1 : looksLoyal ? -1 : 0;
    } else { // 内奸：削弱人多的一方，保住主公到最后再单挑
      if (p === lord) att[p.id] = alive.length === 2 ? -1 : 1;
      else if (rebelsLeft === 0) att[p.id] = -1;
      else if (rebelsLeft > loyalLeft + 1) att[p.id] = looksRebel ? -1 : 0;
      else att[p.id] = looksLoyal ? -1 : 0;
    }
  }
  if (me.role === 'lord' && rebelsLeft === 0) { // 只剩内奸藏在忠臣里：打最可疑的那个
    const cands = alive.filter((p) => p.id !== me.id).sort((a, b) => score[b.id] - score[a.id]);
    if (cands.length) att[cands[0].id] = -1;
  }
  return att;
}

export function decide(v, req) {
  const me = v.players.find((p) => p.id === v.me);
  const byId = Object.fromEntries(v.players.map((p) => [p.id, p]));
  const att = me.role ? attitudes(v, me) : {};
  const A = (id) => (id === me.id ? 1 : att[id] || 0);
  const hand = me.hand || [];
  const lowest = (ids, n) => ids.map((id) => hand.find((c) => c.id === id)).filter(Boolean)
    .sort((a, b) => val(a) - val(b)).slice(0, n).map((c) => c.id);

  switch (req.kind) {
    case 'play': return play();
    case 'respond': return respond();
    case 'discard': {
      if (req.optional) {
        const go = req.ai && (req.ai.always || (req.ai.ifEnemy && A(req.ai.ifEnemy) <= 0));
        if (!go) return {};
      }
      return { cardIds: lowest(req.cards, req.n) };
    }
    case 'choose': return { i: choose() };
    default: return null;
  }

  function choose() {
    const o = req.options;
    if (req.heroChoice) return Math.floor(Math.random() * o.length);
    if (req.confirm) return req.aiYes ? 0 : 1;
    if (req.peek) return ['heal', 'dodge', 'negate', 'plan', 'slash', 'snatch'].includes(req.peek) ? 0 : 1;
    if (req.pick) {
      const friendly = A(req.tgt) > 0;
      const find = (z) => o.findIndex((x) => x.zone === z);
      const order = friendly ? ['judge', 'hand', 'equip'] : ['equip', 'hand', 'judge'];
      for (const z of order) if (find(z) >= 0) return find(z);
      return 0;
    }
    if (req.playerChoice) {
      const cands = o.map((x, i) => ({ i, p: x.pid && byId[x.pid] })).filter((x) => x.p);
      const want = req.aim === 'ally' ? 1 : -1;
      const good = cands.filter((x) => Math.sign(A(x.p.id)) === want).sort((a, b) => a.p.hp - b.p.hp);
      if (good.length) return good[0].i;
      if (req.optional) return o.length - 1;
      return cands[0].i;
    }
    return 0;
  }

  function respond() {
    const yes = { cardId: req.cards[0] };
    const c = req.ctx || {};
    if (req.want === 'dodge' || req.want === 'slash') return yes;
    if (req.want === 'heal') return A(c.dying) > 0 ? yes : {};
    if (req.want === 'negate') {
      const harmful = HARMFUL.has(c.trick);
      const tgt = c.tgt ?? c.src;
      const a = A(tgt);
      const wantStop = (harmful && a > 0) || (!harmful && a < 0);
      const wantGo = (harmful && a < 0) || (!harmful && a > 0);
      return (c.depth % 2 === 0 ? wantStop : wantGo) ? yes : {};
    }
    return {};
  }

  function play() {
    const others = v.players.filter((p) => p.alive && p.id !== me.id);
    const enemiesOf = (ids) => ids.map((id) => byId[id]).filter((p) => A(p.id) < 0);
    const alliesOf = (ids) => ids.map((id) => byId[id]).filter((p) => A(p.id) > 0);
    const slashes = hand.filter((c) => c.name === 'slash').length;
    let best = null, bestScore = 0;
    const consider = (score, ans) => { if (score > bestScore) { bestScore = score; best = ans; } };

    req.options.forEach((o, i) => {
      const es = enemiesOf(o.targets).sort((a, b) => a.hp - b.hp);
      const as = alliesOf(o.targets);
      if (o.skill) {
        if (o.aiOk === false) return;
        const cards = o.nCards ? lowest(o.pickCards, o.nCards) : [];
        if (cards.length !== o.nCards) return;
        if (o.nCards && cards.some((id) => val(hand.find((c) => c.id === id)) >= 7)) return;
        if (o.aim === 'enemy') { if (es.length) consider(6.8, { i, cards, targets: [es[0].id] }); }
        else if (o.aim === 'ally') { if (as.length) consider(6.8, { i, cards, targets: [as[0].id] }); }
        else consider(6.9, { i, cards, targets: [] });
        return;
      }
      const card = hand.find((c) => c.id === o.cardId);
      switch (o.name) {
        case 'plan': consider(9, { i }); break;
        case 'heal':
          if (o.nTargets) {
            const t = o.targets.map((id) => byId[id]).filter((p) => A(p.id) > 0).sort((a, b) => a.hp - b.hp)[0];
            if (t) consider(7, { i, targets: [t.id] });
          } else consider(7, { i });
          break;
        case 'snatch': case 'dismantle': {
          const base = o.name === 'snatch' ? 7.5 : 6.5;
          const trapped = as.find((p) => p.judge.length);
          if (trapped) consider(base + 0.2, { i, targets: [trapped.id] });
          else if (es.length) {
            const t = es.find((p) => p.equip.armor || p.equip.weapon) || es[0];
            consider(base, { i, targets: [t.id] });
          }
          break;
        }
        case 'trap':
          if (es.length) consider(6.2, { i, targets: [[...es].sort((a, b) => b.handCount - a.handCount)[0].id] });
          break;
        case 'slash':
          if (es.length) consider(6, { i, targets: [es[0].id] });
          break;
        case 'duel':
          if (es.length) {
            const t = [...es].sort((a, b) => a.handCount - b.handCount)[0];
            if (slashes >= 1 || t.handCount <= 1) consider(5.5, { i, targets: [t.id] });
          }
          break;
        case 'volley': case 'charge': {
          let s = 0;
          for (const p of others) {
            const a = A(p.id);
            s += a < 0 ? 1 : a > 0 ? (p.role === 'lord' && p.hp <= 1 ? -5 : -1) : 0.2;
          }
          if (s > 0) consider(6.4, { i });
          break;
        }
        case 'feast': {
          let s = me.hp < me.maxHp ? 1 : 0;
          for (const p of others) if (p.hp < p.maxHp) s += A(p.id) > 0 ? 1 : A(p.id) < 0 ? -1 : 0;
          if (s > 0) consider(5, { i });
          break;
        }
        case 'thunder': consider(1.5, { i }); break;
        default:
          if (card && card.type === 'equip') {
            const cur = me.equip[card.sub];
            if (!cur) consider(8, { i });
            else if (card.sub === 'weapon' && (card.range || 0) > (cur.range || 0)) consider(3, { i });
          }
      }
    });
    if (!best) return { end: true };
    return { targets: [], cards: [], ...best };
  }
}
