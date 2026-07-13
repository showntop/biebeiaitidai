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
    const ink = new Color(76, 67, 58, 255);
    const softInk = new Color(112, 101, 88, 255);
    const face = disabled
      ? mixColor(UiTokens.color.disabled, UiTokens.color.paper, locked ? 0.42 : 0.26)
      : mixColor(base, UiTokens.color.paper, 0.08);
    const edge = disabled
      ? mixColor(UiTokens.color.disabled, softInk, 0.22)
      : mixColor(base, ink, 0.34);
    const lift = pressed ? 2 : 6;
    const faceShift = pressed ? -1 : 0;
    const radius = Math.min(UiTokens.radius.large, h * 0.20);

    g.clear();
    // Soft contact shadow only. Large black slabs make these read as cheap UI skins.
    g.fillColor = alphaColor(ink, disabled ? 38 : 74);
    g.roundRect(-w / 2 + 7, -h / 2 - lift - 3, w - 14, Math.max(14, h * 0.22), radius * 0.70);
    g.fill();
    g.fillColor = edge;
    g.roundRect(-w / 2 + 1, -h / 2 - lift, w - 2, h - 2, radius + 1);
    g.fill();
    g.fillColor = face;
    g.strokeColor = disabled ? alphaColor(softInk, 116) : ink;
    g.lineWidth = UiTokens.stroke.normal;
    g.roundRect(-w / 2 + 4, -h / 2 + 4 + faceShift, w - 8, h - lift - 6, radius - 3);
    g.fill(); g.stroke();

    g.fillColor = alphaColor(mixColor(edge, ink, 0.22), disabled ? 46 : 108);
    g.roundRect(-w / 2 + 8, -h / 2 + 6 + faceShift, w - 16, Math.max(6, h * 0.08), 5);
    g.fill();

    g.strokeColor = alphaColor(Color.WHITE, disabled ? 24 : 78);
    g.lineWidth = UiTokens.stroke.hairline;
    g.moveTo(-w / 2 + radius, h / 2 - 10 + faceShift);
    g.lineTo(w / 2 - radius, h / 2 - 10 + faceShift);
    g.stroke();

    if (state === 'ready' || state === 'charging') {
      g.strokeColor = state === 'charging' ? alphaColor(UiTokens.color.gold, 205) : alphaColor(Color.WHITE, 112);
      g.lineWidth = state === 'charging' ? UiTokens.stroke.strong : UiTokens.stroke.hairline;
      g.roundRect(-w / 2 + 9, -h / 2 + 9 + faceShift, w - 18, h - lift - 16, radius - 7);
      g.stroke();
    }
    if (state === 'cooldown') {
      g.fillColor = alphaColor(ink, 66);
      g.roundRect(-w / 2 + 6, -h / 2 + 6, w - 12, h - lift - 10, radius - 5);
      g.fill();
    }
  }

  static card(g: Graphics, w: number, h: number, base: Readonly<Color>, state: CardShellState): void {
    const stateColor = state === 'rework' ? UiTokens.color.rework
      : state === 'inserted' ? UiTokens.color.disabled
      : state === 'boss' ? UiTokens.color.inkDeep
      : base;
    const disabled = state === 'inserted';
    const ink = new Color(88, 78, 68, 255);
    const face = disabled
      ? mixColor(UiTokens.color.disabled, UiTokens.color.paper, 0.34)
      : state === 'boss'
        ? new Color(104, 101, 94, 255)
        : state === 'idle'
          ? mixColor(stateColor, ink, 0.18)
          : mixColor(stateColor, UiTokens.color.paper, 0.12);
    const edge = state === 'boss'
      ? ink
      : mixColor(stateColor, ink, disabled ? 0.32 : 0.22);
    const radius = Math.min(15, Math.max(9, w * 0.16));
    const inset = Math.max(2, Math.min(4, w * 0.040));
    const bottomBand = Math.max(7, Math.min(11, h * 0.12));

    g.clear();
    // Flat task tile: soft contact shadow + one warm ink outline. Avoid button-like stacked bases.
    g.fillColor = alphaColor(ink, disabled ? 24 : 42);
    g.roundRect(-w / 2 + 7, -h / 2 - 5, w - 14, Math.max(8, h * 0.12), radius * 0.55);
    g.fill();

    g.fillColor = face;
    g.strokeColor = alphaColor(ink, disabled ? 116 : 178);
    g.lineWidth = 2;
    g.roundRect(-w / 2 + inset, -h / 2 + inset, w - inset * 2, h - inset * 2, radius);
    g.fill(); g.stroke();

    g.fillColor = alphaColor(edge, disabled ? 72 : 138);
    g.roundRect(-w / 2 + inset + 3, -h / 2 + inset + 3, w - inset * 2 - 6, bottomBand, Math.min(5, radius * 0.45));
    g.fill();

    g.fillColor = alphaColor(Color.WHITE, disabled ? 16 : 42);
    g.roundRect(-w / 2 + inset + 9, h / 2 - inset - 11, w - inset * 2 - 18, 4, 3);
    g.fill();
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
