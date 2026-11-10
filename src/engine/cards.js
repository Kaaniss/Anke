// 牌库定义。所有牌名与效果均为本项目原创设计。
export const CARDS = {
  slash: { cn: '斩', type: 'basic', desc: '出牌阶段对攻击范围内一名其他角色使用，其需打出【挡】，否则受到1点伤害。每回合限一张。' },
  dodge: { cn: '挡', type: 'basic', desc: '被【斩】或【箭雨】指定时打出，抵消其效果。' },
  heal: { cn: '丹', type: 'basic', desc: '出牌阶段对自己使用回复1点体力；或在任意角色濒死时对其使用。' },
  negate: { cn: '破计', type: 'trick', desc: '在一张计策牌对一名角色生效前打出，抵消该效果。【破计】本身也可被【破计】抵消。' },
  snatch: { cn: '劫营', type: 'trick', desc: '获得距离1以内一名其他角色区域里的一张牌。' },
  dismantle: { cn: '焚粮', type: 'trick', desc: '弃置一名其他角色区域里的一张牌。' },
  volley: { cn: '箭雨', type: 'trick', desc: '所有其他角色依次打出一张【挡】，否则受到1点伤害。' },
  charge: { cn: '冲阵', type: 'trick', desc: '所有其他角色依次打出一张【斩】，否则受到1点伤害。' },
  feast: { cn: '犒军', type: 'trick', desc: '所有已受伤的角色各回复1点体力。' },
  plan: { cn: '筹谋', type: 'trick', desc: '摸两张牌。' },
  duel: { cn: '单挑', type: 'trick', desc: '与一名其他角色轮流打出【斩】（对方先出），先不出的一方受到另一方1点伤害。' },
  trap: { cn: '困阵', type: 'delay', desc: '置于一名其他角色的判定区。其判定阶段判定：若不为♥，跳过其出牌阶段。' },
  thunder: { cn: '天雷', type: 'delay', desc: '置于自己的判定区。判定阶段判定：若为♠2~9，受到3点伤害；否则移给下家。' },
  crossbow: { cn: '连弩', type: 'equip', sub: 'weapon', range: 1, desc: '武器·范围1。出牌阶段使用【斩】无次数限制。' },
  sword: { cn: '破甲剑', type: 'equip', sub: 'weapon', range: 2, desc: '武器·范围2。你的【斩】无视目标的防具。' },
  axe: { cn: '开山斧', type: 'equip', sub: 'weapon', range: 3, desc: '武器·范围3。你的【斩】被【挡】抵消后，可弃两张手牌令其依然命中。' },
  halberd: { cn: '长戟', type: 'equip', sub: 'weapon', range: 4, desc: '武器·范围4。' },
  bow: { cn: '强弓', type: 'equip', sub: 'weapon', range: 5, desc: '武器·范围5。你的【斩】造成伤害后，可弃置目标的一匹坐骑。' },
  mystic: { cn: '玄甲', type: 'equip', sub: 'armor', desc: '防具。需要打出【挡】时先判定：若为红色，视为打出了【挡】。' },
  shield: { cn: '铁盾', type: 'equip', sub: 'armor', desc: '防具。黑色的【斩】对你无效。' },
  guardHorse: { cn: '守骑', type: 'equip', sub: 'plus', desc: '坐骑。其他角色计算与你的距离+1。' },
  raidHorse: { cn: '袭骑', type: 'equip', sub: 'minus', desc: '坐骑。你计算与其他角色的距离-1。' },
};

const COUNTS = [
  ['slash', 30], ['dodge', 15], ['heal', 8],
  ['negate', 4], ['snatch', 5], ['dismantle', 6], ['volley', 1], ['charge', 3],
  ['feast', 1], ['plan', 4], ['duel', 3], ['trap', 3], ['thunder', 2],
  ['crossbow', 2], ['sword', 1], ['axe', 1], ['halberd', 1], ['bow', 1],
  ['mystic', 2], ['shield', 1], ['guardHorse', 3], ['raidHorse', 3],
];

const SUITS = ['s', 'h', 'c', 'd'];
export const SUIT_CH = { s: '♠', h: '♥', c: '♣', d: '♦' };
export const NUM_CH = [null, 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

export function buildDeck() {
  const deck = [];
  let id = 0;
  COUNTS.forEach(([name, n], ni) => {
    for (let i = 0; i < n; i++) {
      const def = CARDS[name];
      deck.push({
        id: ++id, name, cn: def.cn, type: def.type, sub: def.sub, range: def.range,
        suit: SUITS[(i + ni) % 4], num: ((i * 5 + ni * 3) % 13) + 1,
      });
    }
  });
  return deck;
}

export const isRed = (c) => c.suit === 'h' || c.suit === 'd';
export const isBlack = (c) => !isRed(c);
export const cardText = (c) => `【${c.cn}${SUIT_CH[c.suit]}${NUM_CH[c.num]}】`;
