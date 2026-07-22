/**
 * 投掷手势的纯规则层：只负责把位移/速度翻译成交互意图，不掺 Cocos 坐标采样。
 * Cocos UI 坐标中 y 向上，因此向下回拉是负 dy，向上甩是正 velocityY。
 */
export interface ThrowGestureTuning {
  manualDeadZone: number;
  horizontalDirectionRatio: number;
  cancelPullDistance: number;
  strongFlickMinVelocity: number;
  strongFlickMaxVelocity: number;
}

export const DefaultThrowGestureTuning: Readonly<ThrowGestureTuning> = Object.freeze({
  manualDeadZone: 18,
  horizontalDirectionRatio: 0.7,
  cancelPullDistance: 54,
  strongFlickMinVelocity: 260,
  strongFlickMaxVelocity: 1100,
});

export function isManualThrowGesture(
  dx: number,
  dy: number,
  tuning: Readonly<ThrowGestureTuning> = DefaultThrowGestureTuning,
): boolean {
  return Math.hypot(dx, dy) >= tuning.manualDeadZone;
}

/** 只有横向意图足够明确才切换目标；向上甩时的自然横漂不会抢走锁定。 */
export function isHorizontalTargetGesture(
  dx: number,
  dy: number,
  tuning: Readonly<ThrowGestureTuning> = DefaultThrowGestureTuning,
): boolean {
  return Math.abs(dx) >= tuning.manualDeadZone
    && Math.abs(dx) > Math.abs(dy) * tuning.horizontalDirectionRatio;
}

export function isThrowCancelGesture(
  dy: number,
  tuning: Readonly<ThrowGestureTuning> = DefaultThrowGestureTuning,
): boolean {
  return dy <= -tuning.cancelPullDistance;
}

/** 甩动只增强演出，不影响是否命中与玩法收益。 */
export function throwPresentationStrength(
  upwardVelocity: number,
  tuning: Readonly<ThrowGestureTuning> = DefaultThrowGestureTuning,
): number {
  const span = Math.max(1, tuning.strongFlickMaxVelocity - tuning.strongFlickMinVelocity);
  return Math.max(0, Math.min(1, (upwardVelocity - tuning.strongFlickMinVelocity) / span));
}

/** 锁卡后始终按卡片身份追踪；卡片离场返回 -1，由表现层安全取消。 */
export function findLockedCardSlot(
  cards: ReadonlyArray<{ id: number } | null>,
  cardId: number | null,
): number {
  if (cardId === null) return -1;
  return cards.findIndex((card) => card?.id === cardId);
}
