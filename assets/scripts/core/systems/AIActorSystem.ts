import type { EventBus } from '../EventBus';
import type { BalanceConfigT } from '../config';
import type { ApprovalZone, ExpressionId } from '../types';

interface ActiveExpr {
  expr: ExpressionId;
  remain: number; // 剩余秒
  priority: number; // 越大越优先
}

/**
 * AI 表情系统（纯表现层，对应策划文档§7）。
 *
 * 监听玩法事件 → 推算应播放的表情（含优先级与时长）→ 发 AIExpression 事件供表现层订阅。
 * 不回写任何数值（开发计划§2 关键原则）。多表情并存时取最高优先级，到期自动回落。
 */
export class AIActorSystem {
  private active: ActiveExpr[] = [];
  private current: ExpressionId | null = null;
  private timeSinceEvent = 0;

  constructor(private bus: EventBus, private cfg: BalanceConfigT) {
    bus.on('CardHit', ({ prop, card }) => this.onCardHit(prop, card?.weight ?? 0));
    bus.on('AIHit', () => {
      this.timeSinceEvent = 0;
      this.request('shy', 6, 2);
    });
    bus.on('ComboUpdated', ({ combo }) => {
      if (combo >= this.cfg.combo.tierExpressions) {
        this.timeSinceEvent = 0;
        this.request('combo-face', 7, 1);
      }
    });
    bus.on('ZoneChanged', ({ to }) => this.onZone(to));
    bus.on('BossIncoming', () => {
      this.timeSinceEvent = 0;
      this.request('busy-pretend', 8, 6); // 装忙直到 Boss 被处理（近似时长）
    });
    bus.on('Highlight', ({ id }) => {
      this.timeSinceEvent = 0;
      if (id === 'perfect-chain' || id === 'boss-clutch') this.request('facepalm', 10, 1.2);
      else if (id === 'combo-5') this.request('crashed', 9, 1.0);
      else if (id === 'hunt-finish') this.request('called-in', 12, 2.0);
      else if (id === 'danger-comeback') this.request('surprised', 8, 0.9);
      else if (id === 'revive-comeback') this.request('panic', 10, 1.1);
    });
  }

  /** 当前应播放的表情（null=回落到默认专注姿态）。 */
  get expression(): ExpressionId | null {
    return this.current;
  }

  tick(dt: number): void {
    for (const a of this.active) a.remain -= dt;
    this.active = this.active.filter((a) => a.remain > 0);

    this.timeSinceEvent += dt;
    if (this.timeSinceEvent > 8 && !this.active.some((a) => a.expr === 'idle-look')) {
      this.request('idle-look', 1, 1.5);
      this.timeSinceEvent = 0;
    }
    this.recompute();
  }

  private onCardHit(prop: string, weight: number): void {
    this.timeSinceEvent = 0;
    if (prop === 'throw-pot') this.request('bewildered', 4, 0.6);
    else if (prop === 'change-demand') {
      if (weight >= 5) this.request('surprised', 6, 0.5); // 关键/提案/紧急
      else this.request('slight-frown', 2, 0.3);
    } else {
      this.request('slight-frown', 2, 0.3); // 加需求插入
    }
  }

  private onZone(to: ApprovalZone): void {
    this.timeSinceEvent = 0;
    if (to === 'ok') this.request('sweat', 3, 1);
    else if (to === 'danger') this.request('panic', 8, 1);
    else if (to === 'good') this.request('confident', 3, 1);
    // hunt 区不额外叠表情（猎杀通关由 called-in 专属演出）
  }

  private request(expr: ExpressionId, priority: number, durationSec: number): void {
    this.active.push({ expr, remain: durationSec, priority });
    this.recompute();
  }

  private recompute(): void {
    let top: ActiveExpr | null = null;
    for (const a of this.active) {
      if (!top || a.priority >= top.priority) top = a; // 同优先级取最近
    }
    const next = top ? top.expr : null;
    if (next !== this.current) {
      this.current = next;
      if (top) this.bus.emit('AIExpression', { expression: top.expr, durationSec: top.remain, priority: top.priority });
    }
  }
}
