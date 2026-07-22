import { Color, Graphics, Label } from 'cc';
import { UiTokens, alphaColor, mixColor } from './UiTokens';

export type KeycapState = 'ready' | 'pressed' | 'charging' | 'cooldown' | 'depleted' | 'locked';
export type CardShellState = 'active' | 'idle' | 'rework' | 'inserted' | 'boss';

/**
 * 统一材质绘制器：只画结构与状态，不持有玩法数据。
 * 组件使用同一光源（左上）、同一底座厚度和同一描边层级。
 */
export class UiPainter {
  static label(label: Label, size: number, color: Readonly<Color>, bold = false): void {
    label.fontFamily = UiTokens.type.family;
    label.fontSize = size;
    label.lineHeight = size + Math.max(3, Math.round(size * 0.22));
    label.color = new Color(color.r, color.g, color.b, color.a);
    label.isBold = bold;
    label.enableWrapText = false;
    label.overflow = Label.Overflow.SHRINK;
  }

  static keycap(g: Graphics, w: number, h: number, base: Readonly<Color>, state: KeycapState): void {
    const locked = state === 'locked';
    const depleted = state === 'depleted';
    const pressed = state === 'pressed';
    const disabled = locked || depleted;
    const radius = Math.min(24, Math.max(15, h * 0.24));
    const innerRadius = Math.max(10, radius - 6);
    const faceShift = pressed ? -4 : 0;
    const lift = pressed ? 2 : 8;
    const ink = UiTokens.color.inkDeep;
    const edge = disabled
      ? alphaColor(UiTokens.color.muted, 58)
      : alphaColor(mixColor(base, ink, 0.32), 178);
    const face = disabled
      ? mixColor(UiTokens.color.ivory, UiTokens.color.disabled, 0.20)
      : mixColor(UiTokens.color.paper, base, 0.035);

    g.clear();
    // Compact keycap: smaller radius + visible bottom thickness. This reads more like a tactile game prop
    // button than a web pill.
    g.fillColor = alphaColor(ink, disabled ? 18 : 48);
    g.roundRect(-w / 2 + 6, -h / 2 - lift - 2, w - 12, h, radius);
    g.fill();

    g.fillColor = disabled ? alphaColor(UiTokens.color.disabled, 76) : alphaColor(mixColor(base, ink, 0.18), 178);
    g.roundRect(-w / 2 + 1, -h / 2 - lift, w - 2, h - 2, radius);
    g.fill();

    g.fillColor = face;
    g.strokeColor = edge;
    g.lineWidth = disabled ? UiTokens.stroke.hairline : UiTokens.stroke.normal;
    g.roundRect(-w / 2 + 2, -h / 2 + 4 + faceShift, w - 4, h - lift - 5, radius);
    g.fill(); g.stroke();

    // Inner bevel and top sheen: one clear light source from upper-left.
    g.strokeColor = alphaColor(Color.WHITE, disabled ? 34 : 132);
    g.lineWidth = UiTokens.stroke.hairline;
    g.roundRect(-w / 2 + 8, -h / 2 + 10 + faceShift, w - 16, h - lift - 18, innerRadius);
    g.stroke();
    g.moveTo(-w / 2 + radius + 6, h / 2 - lift - 9 + faceShift);
    g.lineTo(w / 2 - radius - 6, h / 2 - lift - 9 + faceShift);
    g.stroke();

    // Soft icon well behind the sprite; gives the separate icon a designed home.
    if (!disabled) {
      g.fillColor = alphaColor(base, 24);
      g.circle(0, h * 0.18 + faceShift, Math.min(w, h) * 0.22);
      g.fill();
      g.fillColor = alphaColor(base, 128);
      g.roundRect(-w / 2 + 16, -h / 2 + 10 + faceShift, w - 32, 5, 3);
      g.fill();
    } else {
      g.fillColor = alphaColor(UiTokens.color.disabled, 54);
      g.roundRect(-w / 2 + 12, -h / 2 + 12 + faceShift, w - 24, h - lift - 24, innerRadius);
      g.fill();
    }

    if (state === 'charging') {
      g.strokeColor = alphaColor(UiTokens.color.gold, 210);
      g.lineWidth = UiTokens.stroke.strong;
      g.roundRect(-w / 2 + 7, -h / 2 + 8 + faceShift, w - 14, h - lift - 13, innerRadius);
      g.stroke();
    }
    if (state === 'cooldown') {
      g.fillColor = alphaColor(ink, 34);
      g.roundRect(-w / 2 + 8, -h / 2 + 9, w - 16, h - lift - 15, innerRadius);
      g.fill();
    }
  }

  static card(g: Graphics, w: number, h: number, base: Readonly<Color>, state: CardShellState): void {
    const accent = state === 'rework' ? UiTokens.color.rework
      : state === 'inserted' ? UiTokens.color.disabled
      : state === 'boss' ? UiTokens.color.danger
      : base;
    const disabled = state === 'inserted';
    const ink = new Color(31, 42, 54, 255);
    const face = disabled
      ? mixColor(UiTokens.color.ivory, UiTokens.color.disabled, 0.24)
      : state === 'rework'
        ? mixColor(new Color(255, 252, 246, 255), UiTokens.color.rework, 0.18)
        : new Color(255, 252, 246, 255);
    const radius = Math.min(22, Math.max(14, w * 0.22));
    const tabW = Math.max(24, w * 0.28);
    const tabH = Math.max(18, h * 0.20);
    const inset = Math.max(3, Math.min(5, w * 0.045));

    g.clear();

    // Soft paper-card shadow: visible enough to lift the card, but not button-like.
    g.fillColor = alphaColor(ink, disabled ? 20 : 48);
    g.roundRect(-w / 2 + 8, -h / 2 - 7, w - 12, h - 2, radius);
    g.fill();

    // Small colored folder tab. This preserves category color without turning the whole task into a loud button.
    g.fillColor = alphaColor(accent, disabled ? 82 : 230);
    g.roundRect(w / 2 - tabW - 10, h / 2 - tabH + 2, tabW, tabH, tabH * 0.48);
    g.fill();

    g.fillColor = face;
    g.strokeColor = alphaColor(ink, disabled ? 82 : 238);
    g.lineWidth = disabled ? UiTokens.stroke.hairline : UiTokens.stroke.strong;
    g.roundRect(-w / 2 + inset, -h / 2 + inset, w - inset * 2, h - inset * 2, radius);
    g.fill();
    g.stroke();

    // Paper text-line texture so empty cards still read as "documents in an inbox".
    const lineColor = disabled
      ? alphaColor(UiTokens.color.muted, 54)
      : state === 'rework'
        ? alphaColor(UiTokens.color.rework, 112)
        : new Color(213, 203, 187, 255);
    const left = -w * 0.27;
    const top = h * 0.22;
    [0, 1, 2].forEach((i) => {
      const lineW = w * (i === 0 ? 0.36 : i === 1 ? 0.56 : 0.46);
      g.fillColor = lineColor;
      g.roundRect(left, top - i * h * 0.16, lineW, Math.max(4, h * 0.055), 3);
      g.fill();
    });

    g.fillColor = alphaColor(Color.WHITE, disabled ? 28 : 96);
    g.roundRect(-w / 2 + radius * 0.75, h / 2 - inset - 12, w * 0.34, 4, 3);
    g.fill();

    if (state === 'rework') {
      // 返工态必须在卡片移动过程中也一眼可辨：红色底轨 + 两道批改斜线，
      // 不能只依赖左上角的小负号或一次性命中特效。
      g.fillColor = alphaColor(UiTokens.color.rework, 225);
      g.roundRect(-w / 2 + 12, -h / 2 + 10, w - 24, Math.max(6, h * 0.075), 4);
      g.fill();
      g.strokeColor = alphaColor(UiTokens.color.rework, 185);
      g.lineWidth = Math.max(3, w * 0.035);
      g.moveTo(-w * 0.28, h * 0.13);
      g.lineTo(w * 0.20, -h * 0.20);
      g.moveTo(-w * 0.15, h * 0.22);
      g.lineTo(w * 0.30, -h * 0.10);
      g.stroke();
    }
  }

  static panel(g: Graphics, w: number, h: number, dark = false): void {
    g.clear();
    g.fillColor = alphaColor(UiTokens.color.inkDeep, dark ? 135 : 24);
    g.roundRect(-w / 2 + 4, -h / 2 - 4, w - 8, h, UiTokens.radius.large);
    g.fill();
    g.fillColor = dark ? mixColor(UiTokens.color.ink, UiTokens.color.paper, 0.18) : UiTokens.color.paper;
    g.strokeColor = dark ? alphaColor(Color.WHITE, 55) : alphaColor(UiTokens.color.ink, 112);
    g.lineWidth = UiTokens.stroke.hairline;
    g.roundRect(-w / 2, -h / 2, w, h, UiTokens.radius.large);
    g.fill(); g.stroke();
  }

  static gauge(g: Graphics, w: number, h: number): void {
    const inset = 5;
    const innerH = h - inset * 2;
    g.clear();
    // Static layer is an empty physical track. The colored approval fill is drawn dynamically
    // only up to the current value, so the initial HUD no longer looks pre-filled.
    g.fillColor = alphaColor(UiTokens.color.inkDeep, 165);
    g.roundRect(-w / 2, -h / 2, w, h, h / 2);
    g.fill();

    g.fillColor = alphaColor(UiTokens.color.paper, 72);
    g.roundRect(-w / 2 + inset, -innerH / 2, w - inset * 2, innerH, innerH / 2);
    g.fill();

    g.strokeColor = alphaColor(UiTokens.color.ink, 112);
    g.lineWidth = UiTokens.stroke.hairline;
    g.roundRect(-w / 2 + inset, -innerH / 2, w - inset * 2, innerH, innerH / 2);
    g.stroke();

    // Subtle threshold ticks, not colored segments.
    g.strokeColor = alphaColor(UiTokens.color.ink, 70);
    g.lineWidth = UiTokens.stroke.hairline;
    [0.18, 0.49, 0.69].forEach((ratio) => {
      const x = -w / 2 + inset + (w - inset * 2) * ratio;
      g.moveTo(x, -innerH / 2 + 4);
      g.lineTo(x, innerH / 2 - 4);
      g.stroke();
    });

    g.strokeColor = alphaColor(Color.WHITE, 58);
    g.lineWidth = UiTokens.stroke.hairline;
    g.moveTo(-w / 2 + h / 2, h / 2 - 6);
    g.lineTo(w / 2 - h / 2, h / 2 - 6);
    g.stroke();
  }
}
