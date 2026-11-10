// 武将与技能。人物取自三国历史，技能均为本项目原创设计。
// 新增武将：在 SKILLS 里写技能（挂在引擎时机上），再在 HEROES 里登记即可。
//
// 可用时机（均可为 async）：
//   turnStart(g,p) / turnEnd(g,p)          回合开始 / 结束
//   drawCount(g,p,n) handLimit(g,p,n)      摸牌数 / 手牌上限修正
//   range(g,p,n) distTo(g,p,d,target)      攻击范围 / 与他人距离修正
//   slashLimit(g,p,n) slashAnyRange(g,p)   出斩次数 / 是否无视距离
//   slashHit(g,p,target) slashDodged(g,p,target)
//   afterDodge(g,p) afterHeal(g,p)
//   damaged(g,p,source,n)                  受到伤害后
//   lostHand(g,p)                          回合外手牌被他人弃置或获得后
//   trickTarget(g,p,name,source) -> true   成为他人伤害类计策目标时，返回 true 则无效
//   onDeath(g,p,killer) anyDeath(g,p,dead)
//   active: { option(g,p) -> 选项|null, run(g,p,cards,targets) }  出牌阶段主动技
import { cardText, isRed, isBlack } from './cards.js';

const once = (p, key) => !p.turn.used[key];
const mark = (p, key) => { p.turn.used[key] = true; };

export const SKILLS = {
  juyi: {
    name: '聚义', desc: '回合结束时，若你本回合未造成过伤害，可令一名其他角色摸一张牌。',
    async turnEnd(g, p) {
      if (p.turn.dealt) return;
      const t = await g.choosePlayer(p, g.others(p), '聚义：令一名其他角色摸一张牌', { aim: 'ally', optional: true });
      if (!t) return;
      g.log(`${g.nm(p)} 发动〖聚义〗，${g.nm(t)} 摸一张牌`);
      g.help(p, t); g.draw(t, 1);
    },
  },
  weizhen: {
    name: '威震', desc: '锁定技，你的【斩】造成伤害后，目标随机弃置一张手牌。',
    async slashHit(g, p, t) {
      if (!t.hand.length) return;
      const c = g.takeRandomHand(t);
      g.discardPile.push(c);
      g.log(`${g.nm(p)} 的〖威震〗令 ${g.nm(t)} 弃置了 ${cardText(c)}`);
      await g.lostHand(t);
    },
  },
  nuhou: {
    name: '怒吼', desc: '锁定技，你的【斩】被【挡】抵消后，你摸一张牌。',
    async slashDodged(g, p) { g.log(`${g.nm(p)} 触发〖怒吼〗`); g.draw(p, 1); },
  },
  danji: {
    name: '单骑', desc: '锁定技，你计算与其他角色的距离-1；你打出【挡】后摸一张牌。',
    distTo(g, p, d) { return d - 1; },
    async afterDodge(g, p) { g.log(`${g.nm(p)} 触发〖单骑〗`); g.draw(p, 1); },
  },
  miaosuan: {
    name: '庙算', desc: '回合开始时，你可以观看牌堆顶的一张牌，并可将其置于牌堆底。',
    async turnStart(g, p) {
      const c = g.peek();
      const i = await g.choose(p, [{ label: '留在牌堆顶' }, { label: '置于牌堆底' }],
        `庙算：牌堆顶是 ${cardText(c)}`, { peek: c.name });
      g.log(`${g.nm(p)} 发动〖庙算〗观看了牌堆顶`);
      if (i === 1) g.deck.unshift(g.deck.pop());
    },
  },
  jinshen: {
    name: '谨慎', desc: '锁定技，你的手牌上限+2。',
    handLimit(g, p, n) { return n + 2; },
  },
  baibu: {
    name: '百步', desc: '锁定技，你的攻击范围+2；你的【斩】对体力值不小于你的角色造成伤害后，你摸一张牌。',
    range(g, p, n) { return n + 2; },
    async slashHit(g, p, t) { if (t.hp >= p.hp) { g.log(`${g.nm(p)} 触发〖百步〗`); g.draw(p, 1); } },
  },
  xiaoxiong: {
    name: '枭雄', desc: '锁定技，每当一名其他角色死亡后，你摸两张牌。',
    async anyDeath(g, p) { g.log(`${g.nm(p)} 触发〖枭雄〗`); g.draw(p, 2); },
  },
  yinren: {
    name: '隐忍', desc: '受到其他角色造成的伤害后，你可以判定：若为黑色，伤害来源弃置两张手牌。',
    async damaged(g, p, src) {
      if (!src || !src.alive || src === p || !src.hand.length) return;
      if (!(await g.confirm(p, `隐忍：是否对 ${g.nm(src)} 发动？`))) return;
      g.log(`${g.nm(p)} 发动〖隐忍〗`);
      const j = g.judge(p, '隐忍');
      if (isBlack(j)) { g.harm(p, src); await g.askDiscard(src, 2, { prompt: '隐忍：请弃置两张手牌' }); }
    },
  },
  laomou: {
    name: '老谋', desc: '锁定技，回合结束时，你摸一张牌。',
    async turnEnd(g, p) { g.log(`${g.nm(p)} 触发〖老谋〗`); g.draw(p, 1); },
  },
  bashi: {
    name: '拔矢', desc: '受到其他角色造成的伤害后，你可以弃置一张手牌，对伤害来源造成1点伤害。',
    async damaged(g, p, src) {
      if (!src || !src.alive || src === p || !p.hand.length) return;
      const cs = await g.askDiscard(p, 1, { optional: true, prompt: `拔矢：可弃一张手牌，对 ${g.nm(src)} 造成1点伤害`, ai: { ifEnemy: src.id } });
      if (!cs || !cs.length) return;
      g.log(`${g.nm(p)} 发动〖拔矢〗`);
      g.harm(p, src); await g.damage(p, src, 1);
    },
  },
  qixi: {
    name: '奇袭', desc: '锁定技，你每回合使用的第一张【斩】无距离限制。',
    slashAnyRange(g, p) { return p.turn.slash === 0; },
  },
  huchi: {
    name: '虎痴', desc: '出牌阶段限一次，若你体力值大于1，你可以失去1点体力，令你本回合下一张【斩】伤害+1。',
    active: {
      option(g, p) {
        if (!once(p, 'huchi') || p.hp <= 1) return null;
        const hasSlash = p.hand.some((c) => c.name === 'slash') && p.turn.slash === 0;
        return { label: '虎痴', nCards: 0, nTargets: 0, aim: 'self', aiOk: hasSlash && p.hp >= 3 };
      },
      async run(g, p) {
        mark(p, 'huchi');
        g.log(`${g.nm(p)} 发动〖虎痴〗，失去1点体力`);
        p.turn.rage = true;
        await g.loseHp(p, 1);
      },
    },
  },
  liaodi: {
    name: '料敌', desc: '成为其他角色伤害类计策牌的目标时，你进行判定：若为红色，该牌对你无效。',
    async trickTarget(g, p) {
      g.log(`${g.nm(p)} 触发〖料敌〗`);
      return isRed(g.judge(p, '料敌'));
    },
  },
  yice: {
    name: '遗策', desc: '你死亡时，可令一名其他角色摸三张牌。',
    async onDeath(g, p) {
      const t = await g.choosePlayer(p, g.others(p), '遗策：令一名其他角色摸三张牌', { aim: 'ally', optional: true });
      if (!t) return;
      g.log(`${g.nm(p)} 发动〖遗策〗，${g.nm(t)} 摸三张牌`);
      g.draw(t, 3);
    },
  },
  shouye: {
    name: '守业', desc: '锁定技，你的手牌上限+1；回合结束时，若你本回合未使用【斩】，你摸一张牌。',
    handLimit(g, p, n) { return n + 1; },
    async turnEnd(g, p) { if (p.turn.slash === 0) { g.log(`${g.nm(p)} 触发〖守业〗`); g.draw(p, 1); } },
  },
  huoji: {
    name: '火计', desc: '出牌阶段限一次，你可以弃置一张红色手牌并指定一名其他角色，其须弃置一张红色手牌，否则受到你造成的1点伤害。',
    active: {
      option(g, p) {
        if (!once(p, 'huoji')) return null;
        const reds = p.hand.filter(isRed);
        if (!reds.length) return null;
        return { label: '火计', pickCards: g.ids(reds), nCards: 1, targets: g.ids(g.others(p)), nTargets: 1, aim: 'enemy' };
      },
      async run(g, p, cards, [t]) {
        mark(p, 'huoji');
        g.discardFromHand(p, cards);
        g.log(`${g.nm(p)} 弃置 ${cards.map(cardText).join('')}，对 ${g.nm(t)} 发动〖火计〗`);
        g.harm(p, t);
        const cs = await g.askDiscard(t, 1, { optional: true, filter: isRed, prompt: '火计：弃置一张红色手牌，否则受到1点伤害', ai: { always: true } });
        if (!cs || !cs.length) await g.damage(p, t, 1);
      },
    },
  },
  guqu: {
    name: '顾曲', desc: '锁定技，你于回合外被其他角色弃置或获得手牌后，摸一张牌。',
    async lostHand(g, p) { g.log(`${g.nm(p)} 触发〖顾曲〗`); g.draw(p, 1); },
  },
  dujiang: {
    name: '渡江', desc: '出牌阶段限一次，你可以弃置两张手牌，获得一名其他角色装备区里的一张牌。',
    active: {
      option(g, p) {
        if (!once(p, 'dujiang') || p.hand.length < 2) return null;
        const ts = g.others(p).filter((q) => g.equips(q).length);
        if (!ts.length) return null;
        return { label: '渡江', pickCards: g.ids(p.hand), nCards: 2, targets: g.ids(ts), nTargets: 1, aim: 'enemy', aiOk: p.hand.length >= 4 };
      },
      async run(g, p, cards, [t]) {
        mark(p, 'dujiang');
        g.discardFromHand(p, cards);
        g.log(`${g.nm(p)} 弃置两张手牌，对 ${g.nm(t)} 发动〖渡江〗`);
        g.harm(p, t);
        const r = await g.pickFrom(p, t, '渡江：选择一件装备', { equipOnly: true });
        if (r) { p.hand.push(r.card); g.log(`${g.nm(p)} 获得了 ${cardText(r.card)}`); }
      },
    },
  },
  zhaxiang: {
    name: '诈降', desc: '出牌阶段限一次，你可以将一张手牌交给一名其他角色，然后对其造成1点伤害。',
    active: {
      option(g, p) {
        if (!once(p, 'zhaxiang') || !p.hand.length) return null;
        return { label: '诈降', pickCards: g.ids(p.hand), nCards: 1, targets: g.ids(g.others(p)), nTargets: 1, aim: 'enemy' };
      },
      async run(g, p, cards, [t]) {
        mark(p, 'zhaxiang');
        g.take(p.hand, cards[0]); t.hand.push(cards[0]);
        g.log(`${g.nm(p)} 交给 ${g.nm(t)} 一张手牌，发动〖诈降〗`);
        g.harm(p, t); await g.damage(p, t, 1);
      },
    },
  },
  feijiang: {
    name: '飞将', desc: '锁定技，出牌阶段你可以多使用一张【斩】。',
    slashLimit(g, p, n) { return n + 1; },
  },
  qingcheng: {
    name: '倾城', desc: '出牌阶段限一次，你可以弃置一张手牌，随机获得一名其他角色的一张手牌。',
    active: {
      option(g, p) {
        if (!once(p, 'qingcheng') || !p.hand.length) return null;
        const ts = g.others(p).filter((q) => q.hand.length);
        if (!ts.length) return null;
        return { label: '倾城', pickCards: g.ids(p.hand), nCards: 1, targets: g.ids(ts), nTargets: 1, aim: 'enemy' };
      },
      async run(g, p, cards, [t]) {
        mark(p, 'qingcheng');
        g.discardFromHand(p, cards);
        g.log(`${g.nm(p)} 弃置 ${cards.map(cardText).join('')}，对 ${g.nm(t)} 发动〖倾城〗`);
        g.harm(p, t);
        if (!t.hand.length) return;
        p.hand.push(g.takeRandomHand(t));
        g.log(`${g.nm(p)} 获得了 ${g.nm(t)} 的一张手牌`);
        await g.lostHand(t);
      },
    },
  },
  baiyue: {
    name: '拜月', desc: '锁定技，回合结束时，若你的手牌少于两张，将手牌补至两张。',
    async turnEnd(g, p) { if (p.hand.length < 2) { g.log(`${g.nm(p)} 触发〖拜月〗`); g.draw(p, 2 - p.hand.length); } },
  },
  xuanhu: {
    name: '悬壶', desc: '出牌阶段，你可以对任意一名已受伤的角色使用【丹】。',
    healOthers: true,
  },
  miaoshou: {
    name: '妙手', desc: '锁定技，你使用【丹】后摸一张牌。',
    async afterHeal(g, p) { g.log(`${g.nm(p)} 触发〖妙手〗`); g.draw(p, 1); },
  },
  mengzhu: {
    name: '盟主', desc: '锁定技，摸牌阶段你多摸X张牌（X为其他存活的同势力角色数，至多为2）。',
    drawCount(g, p, n) {
      return n + Math.min(2, g.others(p).filter((q) => q.hero && q.hero.kingdom === p.hero.kingdom).length);
    },
  },
};

export const HEROES = [
  { key: 'liubei', name: '刘备', kingdom: '蜀', hp: 4, skills: ['juyi'] },
  { key: 'guanyu', name: '关羽', kingdom: '蜀', hp: 4, skills: ['weizhen'] },
  { key: 'zhangfei', name: '张飞', kingdom: '蜀', hp: 4, skills: ['nuhou'] },
  { key: 'zhaoyun', name: '赵云', kingdom: '蜀', hp: 4, skills: ['danji'] },
  { key: 'zhugeliang', name: '诸葛亮', kingdom: '蜀', hp: 3, skills: ['miaosuan', 'jinshen'] },
  { key: 'huangzhong', name: '黄忠', kingdom: '蜀', hp: 4, skills: ['baibu'] },
  { key: 'caocao', name: '曹操', kingdom: '魏', hp: 4, skills: ['xiaoxiong'] },
  { key: 'simayi', name: '司马懿', kingdom: '魏', hp: 3, skills: ['yinren', 'laomou'] },
  { key: 'xiahoudun', name: '夏侯惇', kingdom: '魏', hp: 4, skills: ['bashi'] },
  { key: 'zhangliao', name: '张辽', kingdom: '魏', hp: 4, skills: ['qixi'] },
  { key: 'xuchu', name: '许褚', kingdom: '魏', hp: 4, skills: ['huchi'] },
  { key: 'guojia', name: '郭嘉', kingdom: '魏', hp: 3, skills: ['liaodi', 'yice'] },
  { key: 'sunquan', name: '孙权', kingdom: '吴', hp: 4, skills: ['shouye'] },
  { key: 'zhouyu', name: '周瑜', kingdom: '吴', hp: 3, skills: ['huoji', 'guqu'] },
  { key: 'lvmeng', name: '吕蒙', kingdom: '吴', hp: 4, skills: ['dujiang'] },
  { key: 'huanggai', name: '黄盖', kingdom: '吴', hp: 4, skills: ['zhaxiang'] },
  { key: 'lvbu', name: '吕布', kingdom: '群', hp: 4, skills: ['feijiang'] },
  { key: 'diaochan', name: '貂蝉', kingdom: '群', hp: 3, skills: ['qingcheng', 'baiyue'] },
  { key: 'huatuo', name: '华佗', kingdom: '群', hp: 3, skills: ['xuanhu', 'miaoshou'] },
  { key: 'yuanshao', name: '袁绍', kingdom: '群', hp: 4, skills: ['mengzhu'] },
];

export const heroInfo = (h) => ({
  key: h.key, name: h.name, kingdom: h.kingdom, hp: h.hp,
  skills: h.skills.map((k) => ({ name: SKILLS[k].name, desc: SKILLS[k].desc })),
});
