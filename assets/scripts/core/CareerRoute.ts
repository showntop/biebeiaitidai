/** 20 关职业路线的产品分章。仅描述进程与奖励，不参与战斗数值。 */
export interface CareerChapter {
  id: 'survive' | 'counter' | 'upgrade' | 'finale';
  title: string;
  subtitle: string;
  startLevel: number;
  endLevel: number;
  bossLevel: number;
}

export const CareerChapters: readonly CareerChapter[] = Object.freeze([
  { id: 'survive', title: '第一章 · 保住工位', subtitle: '轻点与精准投掷', startLevel: 0, endLevel: 4, bossLevel: 4 },
  { id: 'counter', title: '第二章 · 反向优化', subtitle: '四道具与第一次临检', startLevel: 5, endLevel: 9, bossLevel: 9 },
  { id: 'upgrade', title: '第三章 · 替代升级', subtitle: '精英护盾与任务抱团', startLevel: 10, endLevel: 14, bossLevel: 14 },
  { id: 'finale', title: '终章 · 劝退 AI', subtitle: '连续临检与最终反杀', startLevel: 15, endLevel: 19, bossLevel: 19 },
]);

export interface StarMilestone {
  stars: number;
  cosmetic: 'paper-blue' | 'ai-crash-face' | 'report-gold';
  label: string;
}

/** 星星必须兑换成能看见的收藏，不再只是选关门槛数字。 */
export const StarMilestones: readonly StarMilestone[] = Object.freeze([
  { stars: 6, cosmetic: 'paper-blue', label: '蓝色纸团' },
  { stars: 18, cosmetic: 'ai-crash-face', label: 'AI 崩溃表情' },
  { stars: 36, cosmetic: 'report-gold', label: '金色战报纸' },
]);

export function chapterForLevel(levelIndex: number): CareerChapter {
  return CareerChapters.find((chapter) => levelIndex >= chapter.startLevel && levelIndex <= chapter.endLevel)
    ?? CareerChapters[CareerChapters.length - 1];
}

export function nextStarMilestone(stars: number): StarMilestone | null {
  return StarMilestones.find((milestone) => stars < milestone.stars) ?? null;
}
