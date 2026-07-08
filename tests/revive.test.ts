import { describe, it, expect } from 'vitest';
import { Game } from '../assets/scripts/core/Game';
import { getLevel, BalanceConfig } from '../assets/scripts/core/config';
import { SeededRng } from '../assets/scripts/core/rng';
import { GamePhase as GP } from '../assets/scripts/core/types';

/**
 * §2.1 复活机制验收：
 * - 仅 lose 可复活
 * - 每关限1次
 * - 认可度回滚到 danger.lo（配置驱动，当前 70）
 * - 倒计时 +8 秒
 * - 清除场上 Boss 卡（防二次死亡）
 */
describe('复活机制 §2.1', () => {
  function newGame(levelIndex = 0, seed = 42): Game {
    return new Game(getLevel(levelIndex), new SeededRng(seed));
  }

  const dangerLo = BalanceConfig.zones.danger.lo;

  it('非 lose 状态调用 revive 返回 false', () => {
    const g = newGame();
    const ok = g.revive();
    expect(ok).toBe(false);
    expect(g.revived).toBe(false);
  });

  it('lose 状态：复活成功，认可度回到 danger.lo', () => {
    const g = newGame();
    (g as unknown as { result: string }).result = 'lose';
    const ok = g.revive();
    expect(ok).toBe(true);
    expect(g.revived).toBe(true);
    expect(g.approval.value).toBe(dangerLo);
  });

  it('每关限1次：第二次 revive 返回 false', () => {
    const g = newGame();
    (g as unknown as { result: string }).result = 'lose';
    const ok1 = g.revive();
    expect(ok1).toBe(true);
    expect(g.revived).toBe(true);
    expect(g.approval.value).toBe(dangerLo);

    // 再次推到 lose
    (g as unknown as { result: string }).result = 'lose';
    const ok2 = g.revive();
    expect(ok2).toBe(false);
    expect(g.revived).toBe(true); // 仍是首次的 true
  });

  it('复活后倒计时 +8 秒（durationSec 增加）', () => {
    const g = newGame();
    const beforeDuration = g.getSnapshot().duration;
    (g as unknown as { result: string }).result = 'lose';
    g.revive();
    const afterDuration = g.getSnapshot().duration;
    expect(afterDuration - beforeDuration).toBe(8);
  });

  it('复活清除场上 Boss 卡（防二次死亡）', () => {
    const g = newGame();
    // 通过 generate(forceBoss) 正确生成 Boss 卡（会设置 bossOnBelt 标志）
    g.conveyor.generate(GP.Early, { forceBoss: true });
    expect(g.conveyor.hasBoss()).toBe(true);

    (g as unknown as { result: string }).result = 'lose';
    g.revive();
    expect(g.conveyor.hasBoss()).toBe(false);
  });

  it('Revived 事件被发出（供 UI 弹窗订阅）', () => {
    const g = newGame();
    let revivedEvent: { approval: number; bonusSec: number } | null = null;
    g.bus.on('Revived', (e) => { revivedEvent = e; });

    (g as unknown as { result: string }).result = 'lose';
    g.revive();
    expect(revivedEvent).not.toBeNull();
    expect(revivedEvent!.approval).toBe(dangerLo);
    expect(revivedEvent!.bonusSec).toBe(8);
  });

  it('buildReport 包含 revived 标志（用于战报）', () => {
    const g = newGame();
    (g as unknown as { result: string }).result = 'lose';
    g.revive();
    // 推到通关
    (g as unknown as { result: string }).result = 'win-survive';
    (g as unknown as { stars: number }).stars = 1;
    const report = g.buildReport(0);
    expect(report.revived).toBe(true);
    expect(report.durationSec).toBe(getLevel(0).durationSec + 8);
  });
});
