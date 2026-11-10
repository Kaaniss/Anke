// AI 自对弈冒烟测试：5 人局与 8 人局各跑若干局，检查不崩溃、不卡死、牌数守恒。
import { Game } from '../src/engine/game.js';
import { decide } from '../src/ai/ai.js';

const N = Number(process.argv[2] || 300);
let failed = false;

for (const size of [5, 8]) {
  const tally = { lord: 0, rebel: 0, traitor: 0, draw: 0 };
  let turns = 0;
  for (let seed = 1; seed <= N; seed++) {
    const players = Array.from({ length: size }, (_, i) => ({ id: `p${i}`, name: `电脑${i + 1}`, ai: true }));
    let game;
    const io = { ask: async (pid, req) => decide(game.view(pid), req) };
    game = new Game({ players, io, seed });
    try {
      const r = await game.run();
      tally[r.winner]++;
      turns += game.turnNo;
      const total = game.deck.length + game.discardPile.length
        + game.players.reduce((s, p) => s + p.hand.length + game.equips(p).length + p.judge.length, 0);
      if (total !== 100) throw new Error(`牌数不守恒：${total}`);
    } catch (e) {
      failed = true;
      console.error(`[${size}人局 seed=${seed}] 出错：`, e);
      console.error(game.logs.slice(-15).join('\n'));
      break;
    }
  }
  console.log(`${size}人局 ${N} 局：主忠胜 ${tally.lord}，反贼胜 ${tally.rebel}，内奸胜 ${tally.traitor}，平局 ${tally.draw}，平均 ${(turns / N).toFixed(1)} 回合`);
}
process.exit(failed ? 1 : 0);
