import { Color, Graphics, Node, UITransform, UIOpacity } from 'cc';
import { UiTokens } from './UiTokens';

export interface PressureAtmosphereState {
  zone: string;
  phase: string;
  remainingSec: number;
  nextBossInSec: number | null;
  bossActive: boolean;
  lastChanceImminent: boolean;
  playing: boolean;
}

/** 常驻但克制的边缘氛围；只占四角与短刻度，中央玩法区保持无遮挡。 */
export class PressureAtmosphereView {
  private readonly graphics: Graphics;
  private readonly opacity: UIOpacity;
  private width = 0;
  private height = 0;
  private time = 0;
  private mode = 'calm';
  private lastPaintSignature = '';

  constructor(private readonly root: Node) {
    if (!root.getComponent(UITransform)) root.addComponent(UITransform);
    this.graphics = root.getComponent(Graphics) ?? root.addComponent(Graphics);
    this.opacity = root.getComponent(UIOpacity) ?? root.addComponent(UIOpacity);
    this.opacity.opacity = 0;
  }

  layout(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.root.getComponent(UITransform)?.setContentSize(width, height);
    this.root.setPosition(0, 0, 0);
    this.lastPaintSignature = '';
  }

  update(dt: number, state: PressureAtmosphereState): void {
    this.time += Math.max(0, Math.min(dt, 0.05));
    this.root.active = state.playing;
    if (!state.playing) return;
    const urgent = state.remainingSec <= 10;
    const bossIn = state.nextBossInSec;
    const nextMode = state.lastChanceImminent ? 'last-chance'
      : state.bossActive ? 'boss-active'
        : bossIn !== null && bossIn <= 3 ? 'boss-critical'
          : bossIn !== null && bossIn <= 6 ? 'boss-warning'
            : state.zone === 'danger' ? 'danger'
              : state.zone === 'hunt' ? 'hunt'
                : urgent ? 'urgent'
                  : state.phase === 'crisis' ? 'crisis'
                    : 'calm';
    this.mode = nextMode;
    this.paint();
    if (nextMode === 'calm') {
      this.opacity.opacity = 0;
      return;
    }
    const rate = nextMode === 'last-chance' ? 2.35
      : nextMode === 'boss-critical' ? 1.9
        : nextMode === 'boss-active' ? 1.45
          : nextMode === 'danger' ? 1.7
            : 1.05;
    const pulse = (Math.sin(this.time * Math.PI * 2 * rate) + 1) / 2;
    const base = nextMode === 'last-chance' ? 88
      : nextMode === 'boss-critical' || nextMode === 'boss-active' ? 52
        : nextMode === 'danger' ? 54
          : nextMode === 'hunt' ? 40
            : 24;
    const range = nextMode === 'last-chance' ? 122
      : nextMode === 'boss-critical' || nextMode === 'boss-active' ? 78
        : nextMode === 'danger' ? 66
          : nextMode === 'hunt' ? 48
            : 32;
    this.opacity.opacity = Math.round(base + pulse * range);
  }

  private paint(): void {
    const signature = `${this.mode}|${Math.round(this.width)}|${Math.round(this.height)}`;
    if (signature === this.lastPaintSignature) return;
    this.lastPaintSignature = signature;
    const g = this.graphics;
    g.clear();
    if (this.mode === 'calm') return;
    const bossMode = this.mode.startsWith('boss-');
    const color = this.mode === 'last-chance' ? UiTokens.color.danger
      : bossMode ? new Color(184, 58, 76, 255)
        : this.mode === 'danger' ? UiTokens.color.danger
      : this.mode === 'hunt' ? UiTokens.color.gold
        : UiTokens.color.orange;
    const x = this.width / 2 - Math.max(12, this.width * 0.025);
    const y = this.height / 2 - Math.max(18, this.height * 0.025);
    const arm = Math.max(30, Math.min(58, this.width * 0.11));
    g.strokeColor = new Color(color.r, color.g, color.b, 215);
    g.lineWidth = this.mode === 'danger' || this.mode === 'last-chance' ? 4 : 3;
    const corners: Array<[number, number, number, number]> = [
      [-x, y, 1, -1], [x, y, -1, -1], [-x, -y, 1, 1], [x, -y, -1, 1],
    ];
    for (const [cx, cy, sx, sy] of corners) {
      g.moveTo(cx, cy + sy * arm);
      g.lineTo(cx, cy);
      g.lineTo(cx + sx * arm, cy);
    }
    g.stroke();

    if (bossMode) {
      // Boss 四阶段共享“扫描门”轮廓：6秒稀疏、3秒和在场时加密。
      const dense = this.mode !== 'boss-warning';
      const scanX = x - Math.max(10, this.width * 0.018);
      const scanHalfH = Math.min(this.height * 0.24, 190);
      g.strokeColor = new Color(color.r, color.g, color.b, dense ? 190 : 125);
      g.lineWidth = dense ? 3 : 2;
      for (const side of [-1, 1]) {
        g.moveTo(side * scanX, -scanHalfH);
        g.lineTo(side * scanX, scanHalfH);
        for (let i = -2; i <= 2; i++) {
          const yy = i * scanHalfH * 0.42;
          g.moveTo(side * scanX, yy);
          g.lineTo(side * (scanX - 13), yy + (i % 2 === 0 ? 7 : -7));
        }
      }
      g.stroke();
    }

    if (this.mode === 'last-chance') {
      // 两组向内箭头只占上下边缘，不遮挡任务卡与操作区。
      g.strokeColor = new Color(color.r, color.g, color.b, 235);
      g.lineWidth = 4;
      const arrowY = y - 4;
      for (const sy of [-1, 1]) {
        g.moveTo(-28, sy * arrowY);
        g.lineTo(0, sy * (arrowY - 13));
        g.lineTo(28, sy * arrowY);
      }
      g.stroke();
    }
    g.strokeColor = new Color(color.r, color.g, color.b, 120);
    g.lineWidth = 1.5;
    for (let i = -2; i <= 2; i++) {
      const tickX = i * this.width * 0.12;
      g.moveTo(tickX - 7, y);
      g.lineTo(tickX + 7, y);
      g.moveTo(tickX - 7, -y);
      g.lineTo(tickX + 7, -y);
    }
    g.stroke();
  }
}
