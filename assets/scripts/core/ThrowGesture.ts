/**
 * 投掷手势的纯规则层：只负责把位移/速度翻译成交互意图，不掺 Cocos 坐标采样。
 * Cocos UI 坐标中 y 向上，因此向下回拉是负 dy，向上甩是正 velocityY。
 */
export interface ThrowGestureTuning {
  manualDeadZone: number;
  strongFlickMinVelocity: number;
  strongFlickMaxVelocity: number;
}

export const DefaultThrowGestureTuning: Readonly<ThrowGestureTuning> = Object.freeze({
  manualDeadZone: 18,
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

/**
 * 把“从按钮朝任务卡拖”的方向投影到任务卡所在横排。
 * 手指尚未明显上移时保留当前横坐标，避免很小的 dy 放大成跳槽。
 */
export function projectedThrowTargetX(
  startX: number,
  startY: number,
  currentX: number,
  currentY: number,
  targetRowY: number,
  maxScale = 2.4,
): number {
  const dy = currentY - startY;
  if (dy <= 12 || targetRowY <= startY) return currentX;
  const scale = Math.max(0.65, Math.min(maxScale, (targetRowY - startY) / dy));
  return startX + (currentX - startX) * scale;
}

/**
 * 投掷弧线最高点始终留在安全区内。目标已贴近屏顶时自动压低弧度，
 * 避免“明明点中卡片，道具却先飞出屏幕”。
 */
export function boundedThrowPeakY(
  startY: number,
  endY: number,
  viewportTopY: number,
  desiredLift: number,
  topMargin = 28,
): number {
  const baseY = Math.max(startY, endY);
  const ceilingY = Math.max(baseY, viewportTopY - topMargin);
  return Math.min(baseY + Math.max(0, desiredLift), ceilingY);
}

export interface ThrowPoint {
  x: number;
  y: number;
}

/** 引导投掷的第一段：保留大部分松手方向，只混入少量朝目标的拉力。 */
export function guidedThrowLeadPoint(
  start: ThrowPoint,
  end: ThrowPoint,
  velocity: ThrowPoint,
  manualThrow: boolean,
): ThrowPoint {
  const toTargetX = end.x - start.x;
  const toTargetY = end.y - start.y;
  const distance = Math.max(1, Math.hypot(toTargetX, toTargetY));
  const targetDirX = toTargetX / distance;
  const targetDirY = toTargetY / distance;
  const speed = Math.hypot(velocity.x, velocity.y);
  let dirX = targetDirX;
  let dirY = targetDirY;
  if (manualThrow && speed >= 220 && velocity.y > 20) {
    const velocityDirX = velocity.x / speed;
    const velocityDirY = velocity.y / speed;
    dirX = velocityDirX * 0.82 + targetDirX * 0.18;
    dirY = velocityDirY * 0.82 + targetDirY * 0.18;
    const blendedLength = Math.max(0.001, Math.hypot(dirX, dirY));
    dirX /= blendedLength;
    dirY /= blendedLength;
  }
  const leadDistance = Math.max(48, Math.min(150, distance * (manualThrow ? 0.30 : 0.22)));
  return { x: start.x + dirX * leadDistance, y: start.y + dirY * leadDistance };
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
