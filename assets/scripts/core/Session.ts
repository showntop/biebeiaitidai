/**
 * 关卡流会话（核心规则层）—— 对应《关卡节奏与IAA社交裂变方案》
 * §1.0 关卡进度 + §1.5 失败重试顺畅 + §3.2 段位 + §3.3 战报。
 *
 * 把"选关→开打→结算→解锁/段位/战报→下一关"的可测试流程抽到 core，
 * Cocos 表现层只做薄壳（读 Session 状态渲染、把按钮事件转成 Session 调用）。
 *
 * 持久化通过 Storage 接口注入（实现端用 wx.setStorageSync / LocalStorage），
 * core 不直接依赖平台 API，便于在 Node 下用 InMemoryStorage 单测。
 */
import { LevelSequence, getLevel, allowedPropsForLevel } from './config';
import type { PropType } from './types';
import { createProfile, applyDailyChallengeResult, applyRunResult, rankOf, RankLabels, hydrateProfile } from './profile';
import type { PlayerProfile } from './profile';
import type { RunReport } from './RunReport';
import type { ChallengeSpec } from './SocialChallenge';

export type SessionPhase = 'ready' | 'playing' | 'finished';

/** 档案持久化接口（由表现层实现：微信 wx.setStorageSync / 浏览器 LocalStorage 等）。 */
export interface Storage {
  loadProfile(): PlayerProfile | null;
  saveProfile(p: PlayerProfile): void;
}

/** 默认空存储（不持久化），供无需存档的场景兜底。 */
export class NoopStorage implements Storage {
  loadProfile(): PlayerProfile | null {
    return null;
  }
  saveProfile(_p: PlayerProfile): void {}
}

/** 内存存储，供单测 / 单次会话缓存。 */
export class InMemoryStorage implements Storage {
  private p: PlayerProfile | null = null;
  loadProfile(): PlayerProfile | null {
    return this.p;
  }
  saveProfile(p: PlayerProfile): void {
    this.p = p;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export class Session {
  readonly profile: PlayerProfile;
  currentIndex: number;
  lastReport: RunReport | null = null;
  phase: SessionPhase = 'ready';
  activeChallenge: ChallengeSpec | null = null;

  constructor(private storage: Storage = new NoopStorage(), startIndex?: number) {
    // 反序列化后重 hydrate，保证 daysEmployed 等 getter 不丢
    this.profile = hydrateProfile(storage.loadProfile());
    const start = startIndex ?? this.profile.highestUnlockedLevel;
    this.currentIndex = clamp(start, 0, LevelSequence.length - 1);
  }

  get levelCount(): number {
    return LevelSequence.length;
  }
  get rankLabel(): string {
    return RankLabels[rankOf(this.profile)];
  }
  get daysEmployed(): number {
    return this.profile.daysEmployed;
  }
  get storageUsed(): Storage {
    return this.storage;
  }

  /** 第 idx 关是否已解锁（可进入）。第 0 关默认解锁。 */
  isLevelUnlocked(idx: number): boolean {
    return idx <= this.profile.highestUnlockedLevel;
  }

  /** §1.2 第 idx 关本关允许的道具（错峰解锁累积集合）。 */
  allowedPropsFor(idx: number): PropType[] {
    return allowedPropsForLevel(idx);
  }

  /** 当前关叙事标题。 */
  currentTitle(): string {
    const def = getLevel(this.currentIndex);
    return def.title ?? def.id;
  }

  /** 进入第 idx 关（需已解锁）。返回是否成功。 */
  startLevel(idx: number): boolean {
    if (!this.isLevelUnlocked(idx)) return false;
    this.currentIndex = clamp(idx, 0, LevelSequence.length - 1);
    this.phase = 'playing';
    this.lastReport = null;
    this.activeChallenge = null;
    return true;
  }

  /** 社交挑战不受主线解锁限制，也不会反向污染主线解锁进度。 */
  startChallenge(spec: ChallengeSpec): boolean {
    if (spec.levelIndex < 0 || spec.levelIndex >= LevelSequence.length) return false;
    this.currentIndex = spec.levelIndex;
    this.activeChallenge = spec;
    this.phase = 'playing';
    this.lastReport = null;
    return true;
  }

  leaveChallenge(): void {
    this.activeChallenge = null;
    this.currentIndex = this.profile.highestUnlockedLevel;
    this.phase = 'ready';
  }

  /** 继续"最高解锁关"进度（最常用的进入方式）。 */
  continueProgress(): boolean {
    return this.startLevel(this.profile.highestUnlockedLevel);
  }

  /**
   * 结算本关：把战报写入 profile（通关则解锁下一关、计猎杀/三星）、持久化、转 finished。
   * 失败也写一次存档（保留已有进度），但 applyRunResult 内部不会解锁/计分。
   */
  finishLevel(report: RunReport): void {
    this.lastReport = report;
    if (!this.activeChallenge) {
      applyRunResult(this.profile, this.currentIndex, report);
      this.storage.saveProfile(this.profile);
    } else if (this.activeChallenge.mode === 'daily') {
      applyDailyChallengeResult(this.profile, this.activeChallenge.keyHash.toString(36), report);
      this.storage.saveProfile(this.profile);
    }
    this.phase = 'finished';
  }

  /** 下一关是否可进入（需通关解锁了下一关）。 */
  get hasNext(): boolean {
    return !this.activeChallenge && this.currentIndex + 1 < LevelSequence.length && this.isLevelUnlocked(this.currentIndex + 1);
  }
  get isLastLevel(): boolean {
    return this.currentIndex >= LevelSequence.length - 1;
  }
  /** 开始下一关（需 hasNext）。 */
  startNext(): boolean {
    return this.hasNext ? this.startLevel(this.currentIndex + 1) : false;
  }
}
