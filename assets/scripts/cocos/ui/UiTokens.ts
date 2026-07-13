import { Color } from 'cc';

/**
 * 全局游戏 UI 令牌。
 *
 * 约束：页面与组件不得重新声明颜色、圆角、描边、字号和动效时长。
 * 所有视觉修改都从这里向下传播，避免 GameRunner 内出现“每块 UI 各画各的”。
 */
export const UiTokens = Object.freeze({
  color: Object.freeze({
    ivory: new Color(244, 235, 221, 255),
    paper: new Color(255, 250, 241, 255),
    paperMuted: new Color(238, 231, 219, 255),
    ink: new Color(76, 67, 58, 255),
    inkDeep: new Color(54, 48, 42, 255),
    muted: new Color(122, 113, 101, 255),
    disabled: new Color(196, 190, 181, 255),
    walnut: new Color(168, 124, 88, 255),
    // 功能色统一降饱和，向暖纸世界观靠拢：主色=琥珀/胡桃木，警示=危险红。
    blue: new Color(106, 140, 168, 255),
    orange: new Color(216, 142, 66, 255),
    purple: new Color(146, 116, 150, 255),
    cyan: new Color(104, 158, 152, 255),
    amber: new Color(244, 172, 32, 255),
    pink: new Color(202, 126, 140, 255),
    rework: new Color(226, 64, 54, 255),
    hunt: new Color(150, 66, 58, 255),
    good: new Color(78, 170, 74, 255),
    ok: new Color(221, 171, 43, 255),
    danger: new Color(226, 64, 54, 255),
    gold: new Color(246, 200, 42, 255),
  }),
  radius: Object.freeze({
    small: 7,
    medium: 12,
    large: 17,
    dock: 20,
  }),
  stroke: Object.freeze({
    hairline: 2,
    normal: 3,
    strong: 4,
    focus: 5,
  }),
  space: Object.freeze({
    xxs: 4,
    xs: 8,
    sm: 12,
    md: 16,
    lg: 24,
    xl: 32,
  }),
  type: Object.freeze({
    display: 48,
    title: 34,
    value: 30,
    action: 26,
    body: 18,
    caption: 15,
    micro: 16,
    family: 'PingFang SC',
  }),
  motion: Object.freeze({
    pressSec: 0.06,
    releaseSec: 0.10,
    popSec: 0.18,
    panelSec: 0.22,
  }),
});

export function mixColor(a: Readonly<Color>, b: Readonly<Color>, amount: number, alpha = 255): Color {
  const t = Math.max(0, Math.min(1, amount));
  return new Color(
    Math.round(a.r * (1 - t) + b.r * t),
    Math.round(a.g * (1 - t) + b.g * t),
    Math.round(a.b * (1 - t) + b.b * t),
    alpha,
  );
}

export function alphaColor(color: Readonly<Color>, alpha: number): Color {
  return new Color(color.r, color.g, color.b, Math.max(0, Math.min(255, Math.round(alpha))));
}
