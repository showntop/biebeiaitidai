export interface StartCardMetrics {
  width: number;
  height: number;
  cy: number;
  narrow: boolean;
}

/**
 * 开始页主卡片布局度量。
 *
 * 这类纯计算先从 GameRunner 抽出，后续 StartPageView 可以复用它；
 * 同时避免视觉布局数字继续散落在总控脚本里。
 */
export function getStartCardMetrics(viewWidth: number, viewHeight: number): StartCardMetrics {
  const narrow = viewHeight / Math.max(1, viewWidth) >= 1.5;
  const width = Math.min(viewWidth * (narrow ? 0.895 : 0.82), narrow ? 1000 : 860);
  const height = narrow
    ? Math.min(viewHeight * 0.455, width * 1.12)
    : Math.min(viewHeight * 0.47, width * 0.90);
  const cy = narrow ? viewHeight * 0.02 : viewHeight * 0.095;
  return { width, height, cy, narrow };
}
