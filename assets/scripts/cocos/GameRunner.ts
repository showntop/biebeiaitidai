import { _decorator, Component, Node, Label, Sprite, UITransform, Vec3, Color, instantiate, Prefab, Button, ProgressBar, math } from 'cc';
import { Game } from '../core/Game';
import { DefaultLevel } from '../core/config';
import { SeededRng } from '../core/rng';
import { PropType as PT } from '../core/types';
import type { Card, GameResult, PropType } from '../core/types';

const { ccclass, property } = _decorator;

/**
 * 最小可玩版本入口（M2第一步）：
 * 挂在场景根节点上，持有 Game 实例，驱动 tick + 接收输入 + 渲染。
 *
 * 不追求美术表现，先验证"Cocos表现层能正确订阅core事件并反映到画面"。
 * 后续美术资源接入后替换占位渲染即可。
 */
@ccclass('GameRunner')
export class GameRunner extends Component {
  @property(Node)
  beltNode: Node | null = null; // 传送带容器（6个子节点=6格）

  @property(Label)
  approvalLabel: Label | null = null;

  @property(Label)
  zoneLabel: Label | null = null;

  @property(Label)
  timerLabel: Label | null = null;

  @property(Label)
  resultLabel: Label | null = null;

  @property(Node)
  propButtons: Node | null = null; // 4个道具按钮容器

  @property(Node)
  scanIndicator: Node | null = null; // 蓄力扫描指示器

  private game!: Game;
  private dt = 0.05; // 逻辑步进
  private accumulator = 0;
  private slotNodes: Node[] = [];
  private scanPos = 0;

  onLoad(): void {
    this.game = new Game(DefaultLevel, new SeededRng(Date.now() % 100000));

    // 收集传送带子节点
    if (this.beltNode) {
      this.beltNode.children.forEach((child: Node) => this.slotNodes.push(child));
    }

    // 绑定道具按钮
    if (this.propButtons) {
      const labels = ['加需求', '改需求', '丢锅', '拍马屁'];
      const types = [PT.AddDemand, PT.ChangeDemand, PT.ThrowPot, PT.KissUp];
      this.propButtons.children.forEach((btn: Node, i: number) => {
        const label = btn.getComponent(Label);
        if (label) label.string = labels[i] ?? '';
        btn.on(Node.EventType.TOUCH_START, () => this.onPropDown(types[i]));
        btn.on(Node.EventType.TOUCH_END, () => this.onPropUp(types[i]));
        btn.on(Node.EventType.TOUCH_CANCEL, () => this.onPropCancel(types[i]));
      });
    }
  }

  start(): void {
    this.render();
  }

  update(dt: number): void {
    if (this.game.over) {
      this.showResult();
      return;
    }

    // 输入扫描进度推进（视觉反馈）
    const chargingProp = this.game.prop.chargingProp;
    if (chargingProp !== null) {
      this.scanPos += dt / 1.0; // scanSec=1.0
      if (this.scanPos > 1) this.scanPos = 1;
    } else {
      this.scanPos = 0;
    }

    // 逻辑步进（固定dt）
    this.accumulator += dt;
    while (this.accumulator >= this.dt) {
      this.accumulator -= this.dt;
      this.game.tick(this.dt);
      if (this.game.over) break;
    }

    this.render();
  }

  /* ---------- 输入 ---------- */

  private onPropDown(prop: PropType): void {
    if (prop === PT.KissUp) {
      this.game.useKissUp();
    } else {
      this.game.beginCharge(prop);
    }
  }

  private onPropUp(prop: PropType): void {
    if (prop !== PT.KissUp) {
      this.game.release(prop);
    }
  }

  private onPropCancel(prop: PropType): void {
    if (prop !== PT.KissUp) {
      this.game.cancel(prop);
    }
  }

  /* ---------- 渲染 ---------- */

  private render(): void {
    const snap = this.game.getSnapshot();

    // 认可度
    if (this.approvalLabel) {
      this.approvalLabel.string = `认可度: ${Math.round(snap.approval)}`;
    }
    if (this.zoneLabel) {
      this.zoneLabel.string = snap.zone.toUpperCase();
      const colors: Record<string, Color> = {
        hunt: new Color(100, 80, 255),
        good: new Color(80, 180, 80),
        ok: new Color(200, 200, 80),
        danger: new Color(220, 60, 60),
      };
      this.zoneLabel.color = colors[snap.zone] ?? Color.WHITE;
    }

    // 倒计时
    if (this.timerLabel) {
      const remain = Math.max(0, snap.duration - snap.elapsed);
      this.timerLabel.string = `${remain.toFixed(1)}s`;
    }

    // 传送带
    const cards = this.game.conveyor.cards;
    for (let i = 0; i < this.slotNodes.length; i++) {
      const node = this.slotNodes[i];
      const card = cards[i];
      this.renderSlot(node, card);
    }

    // 扫描指示器
    if (this.scanIndicator && chargingPropCheck(this.game)) {
      this.scanIndicator.active = true;
      const slots = this.slotNodes.length;
      const idx = Math.min(slots - 1, Math.floor(this.scanPos * slots));
      if (this.slotNodes[idx]) {
        const pos = this.slotNodes[idx].position;
        this.scanIndicator.setPosition(pos.x, pos.y, 0);
      }
    } else if (this.scanIndicator) {
      this.scanIndicator.active = false;
    }
  }

  private renderSlot(node: Node, card: Card | null): void {
    if (!card) {
      node.getComponent(Label)!.string = '---';
      return;
    }
    const label = node.getComponent(Label);
    if (!label) return;

    let text = '';
    let color = Color.WHITE;

    switch (card.state) {
      case 'active-white':
        text = `${card.category}\n+${card.weight}`;
        color = new Color(80, 160, 255);
        break;
      case 'rework':
        text = `返工\n-${card.weight}`;
        color = new Color(220, 60, 60);
        break;
      case 'inserted':
        text = '杂活\n+0';
        color = new Color(150, 150, 150);
        break;
      case 'idle':
        text = `${card.category}\n摸鱼`;
        color = new Color(120, 120, 120);
        break;
      case 'boss':
        text = 'BOSS\n临检!';
        color = new Color(40, 40, 40);
        break;
    }
    label.string = text;
    label.color = color;
  }

  private showResult(): void {
    if (!this.resultLabel) return;
    const r = this.game.result;
    const texts: Record<string, string> = {
      'win-hunt': 'AI摸鱼被劝退！猎杀通关！',
      'win-survive': '今天AI还替代不了你',
      lose: 'AI已能替代你！你被优化了',
      ongoing: '',
    };
    this.resultLabel.string = texts[r] ?? '';
    this.resultLabel.node.active = true;
  }
}

function chargingPropCheck(g: Game): boolean {
  return g.prop.chargingProp !== null;
}
