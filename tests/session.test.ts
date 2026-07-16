import { describe, it, expect } from 'vitest';
import { Session, InMemoryStorage, NoopStorage } from '../assets/scripts/core/Session';
import { createProfile, hydrateProfile } from '../assets/scripts/core/profile';
import { PropType as PT } from '../assets/scripts/core/types';
import type { RunReport } from '../assets/scripts/core/RunReport';
import type { PlayerProfile } from '../assets/scripts/core/profile';

function mkReport(result: RunReport['result'], stars: number, levelIndex: number): RunReport {
  return {
    result,
    stars,
    levelIndex,
    levelId: `level-${levelIndex + 1}`,
    levelTitle: `第${levelIndex + 1}轮反击`,
    peakApproval: 50,
    finalApproval: 50,
    timeUsedSec: 60,
    durationSec: 60,
    bossInspectionsFired: 0,
    maxCombo: 0,
    effectiveHits: 0,
    perfectHits: 0,
    missedThrows: 0,
    revived: false,
  };
}

describe('Session · 初始与选关', () => {
  it('新会话：profile 初始、当前关=第1关、ready 态', () => {
    const s = new Session();
    expect(s.profile.highestUnlockedLevel).toBe(0);
    expect(s.currentIndex).toBe(0);
    expect(s.phase).toBe('ready');
    expect(s.isLastLevel).toBe(false);
  });

  it('未解锁的关 startLevel 被拒', () => {
    const s = new Session();
    expect(s.startLevel(2)).toBe(false); // 只解锁了第0关
    expect(s.startLevel(0)).toBe(true);
    expect(s.phase).toBe('playing');
  });

  it('continueProgress 进入最高解锁关', () => {
    const s = new Session();
    expect(s.continueProgress()).toBe(true);
    expect(s.currentIndex).toBe(0);
  });

  it('allowedPropsFor：L1 只加/改需求，L5 解锁丢锅', () => {
    const s = new Session();
    expect(s.allowedPropsFor(0)).toEqual(expect.arrayContaining([PT.AddDemand, PT.ChangeDemand]));
    expect(s.allowedPropsFor(0)).not.toContain(PT.ThrowPot);
    expect(s.allowedPropsFor(4)).toContain(PT.ThrowPot);
  });
});

describe('Session · 结算与解锁', () => {
  it('通关1星：解锁下一关，hasNext=true，startNext 进入', () => {
    const s = new Session(new InMemoryStorage());
    s.startLevel(0);
    s.finishLevel(mkReport('win-survive', 1, 0));
    expect(s.phase).toBe('finished');
    expect(s.profile.highestUnlockedLevel).toBe(1);
    expect(s.hasNext).toBe(true);
    expect(s.startNext()).toBe(true);
    expect(s.currentIndex).toBe(1);
  });

  it('失败：不解锁下一关，hasNext=false', () => {
    const s = new Session();
    s.startLevel(0);
    s.finishLevel(mkReport('lose', 0, 0));
    expect(s.profile.highestUnlockedLevel).toBe(0);
    expect(s.hasNext).toBe(false);
  });

  it('猎杀通关计 huntWinCount，三星记入 star3Levels', () => {
    const s = new Session();
    s.startLevel(0);
    s.finishLevel(mkReport('win-hunt', 3, 0));
    expect(s.profile.huntWinCount).toBe(1);
    expect(s.profile.star3Levels).toEqual([0]);
  });

  it('末关通关：isLastLevel=true，hasNext=false（不会越界）', () => {
    const s = new Session();
    const last = 19; // 末关 index（20 关序列）
    s.profile.highestUnlockedLevel = last;
    s.startLevel(last);
    s.finishLevel(mkReport('win-survive', 1, last));
    expect(s.isLastLevel).toBe(true);
    expect(s.hasNext).toBe(false);
    expect(s.startNext()).toBe(false);
  });
});

describe('Session · 持久化', () => {
  it('InMemoryStorage 跨会话保留进度（继续上次未通关的最高解锁关）', () => {
    const storage = new InMemoryStorage();
    const s1 = new Session(storage);
    s1.startLevel(0);
    s1.finishLevel(mkReport('win-survive', 1, 0)); // 解锁第1关并保存
    expect(storage.loadProfile()!.highestUnlockedLevel).toBe(1);

    const s2 = new Session(storage); // 新会话读存档
    expect(s2.profile.highestUnlockedLevel).toBe(1);
    expect(s2.currentIndex).toBe(1); // 默认继续第1关
    expect(s2.continueProgress()).toBe(true);
  });

  it('hydrateProfile：JSON 往返后 daysEmployed 固化为快照，hydrate 恢复成实时 getter', () => {
    const original = createProfile();
    original.highestUnlockedLevel = 3;
    original.huntWinCount = 5;
    original.star3Levels = [0, 2];
    // JSON.stringify 会调用 getter，把它固化成"数据字段快照"——值正确，但不再随字段变化
    const roundtripped = JSON.parse(JSON.stringify(original)) as PlayerProfile;
    expect(roundtripped.daysEmployed).toBe(4);
    roundtripped.highestUnlockedLevel = 8;
    expect(roundtripped.daysEmployed).toBe(4); // 快照不更新（直接用反序列化对象的坑）

    const hydrated = hydrateProfile(roundtripped);
    expect(hydrated.highestUnlockedLevel).toBe(8);
    expect(hydrated.huntWinCount).toBe(5);
    expect(hydrated.star3Levels).toEqual([0, 2]);
    expect(hydrated.daysEmployed).toBe(9); // getter 复活，= highestUnlockedLevel(8)+1
  });

  it('NoopStorage 默认不持久化（新会话总是从初始档案开始）', () => {
    const s1 = new Session(new NoopStorage());
    s1.startLevel(0);
    s1.finishLevel(mkReport('win-survive', 1, 0));
    const s2 = new Session(new NoopStorage());
    expect(s2.profile.highestUnlockedLevel).toBe(0);
  });
});

describe('Session · 段位/战报文案', () => {
  it('rankLabel 返回中文段位', () => {
    const s = new Session();
    expect(s.rankLabel).toBe('岗位保卫者');
    s.profile.huntWinCount = 20; // 20*3=60 → AI干扰专家
    expect(s.rankLabel).toBe('AI干扰专家');
  });
});
