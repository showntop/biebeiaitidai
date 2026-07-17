import { describe, expect, it } from 'vitest';
import { MemoryTelemetrySink, RunTelemetry } from '../assets/scripts/core/Telemetry';
import type { RunReport } from '../assets/scripts/core/RunReport';

function report(result: RunReport['result'] = 'win-survive'): RunReport {
  return {
    result,
    stars: result === 'lose' ? 0 : 3,
    levelIndex: 0,
    levelId: 'level-1',
    levelTitle: '第1关',
    peakApproval: result === 'lose' ? 100 : 48,
    finalApproval: result === 'lose' ? 100 : 40,
    timeUsedSec: 60,
    durationSec: 60,
    bossInspectionsFired: 0,
    maxCombo: 3,
    effectiveHits: 2,
    perfectHits: 1,
    missedThrows: 1,
    revived: false,
  };
}

describe('RunTelemetry', () => {
  it('首个漏斗事件按局去重并保留耗时', () => {
    let now = 1000;
    const sink = new MemoryTelemetrySink();
    const telemetry = new RunTelemetry(sink, {
      sessionId: 's1', platform: 'test', deviceTier: 'mid', appVersion: '0.1.0',
    }, () => now);
    telemetry.startLevel(0, 42);
    now += 120;
    telemetry.dragStarted();
    telemetry.dragStarted();
    now += 80;
    telemetry.released('add-demand');
    telemetry.released('add-demand');
    now += 300;
    telemetry.validHit('add-demand', 'perfect');
    telemetry.validHit('add-demand', 'perfect');

    expect(sink.events.filter((e) => e.name === 'first_drag')).toHaveLength(1);
    expect(sink.events.filter((e) => e.name === 'first_release')).toHaveLength(1);
    expect(sink.events.filter((e) => e.name === 'first_valid_hit')).toHaveLength(1);
    expect(sink.events.filter((e) => e.name === 'first_perfect')).toHaveLength(1);
    expect(sink.events.find((e) => e.name === 'first_valid_hit')?.payload.sinceLevelStartMs).toBe(500);
  });

  it('局末聚合手感率、道具分布、FPS 分位与失败原因', () => {
    let now = 0;
    const sink = new MemoryTelemetrySink();
    const telemetry = new RunTelemetry(sink, {
      sessionId: 's2', platform: 'test', deviceTier: 'low', appVersion: '0.1.0',
    }, () => now);
    telemetry.startLevel(2, 7);
    telemetry.released('change-demand');
    telemetry.released('throw-pot');
    telemetry.validHit('change-demand', 'normal');
    telemetry.invalidTarget('throw-pot', 'empty');
    telemetry.gestureCanceled('add-demand');
    telemetry.sampleFrame(1 / 60);
    telemetry.sampleFrame(1 / 30);
    now = 12000;
    telemetry.endLevel(report('lose'), 'boss-inspection');
    telemetry.navigation('retry');

    const end = sink.events.find((e) => e.name === 'level_end');
    expect(end?.payload).toMatchObject({
      durationMs: 12000,
      effectiveHits: 1,
      releases: 2,
      invalidTargets: 1,
      cancels: 1,
      hitRate: 0.5,
      cancelRate: 0.3333,
      changeDemandUses: 1,
      throwPotUses: 1,
      fpsP50: 30,
      fpsP10: 30,
    });
    expect(sink.events.find((e) => e.name === 'fail_reason')?.payload.reason).toBe('boss-inspection');
    expect(sink.events.find((e) => e.name === 'retry')).toMatchObject({ runId: 's2-1', levelIndex: 2 });
  });

  it('新一局会重置首次事件和聚合统计', () => {
    const sink = new MemoryTelemetrySink();
    const telemetry = new RunTelemetry(sink, {
      sessionId: 's3', platform: 'test', deviceTier: 'high', appVersion: '0.1.0',
    }, () => 100);
    telemetry.startLevel(0, 1);
    telemetry.dragStarted();
    telemetry.endLevel(report());
    telemetry.startLevel(1, 2);
    telemetry.dragStarted();
    expect(sink.events.filter((e) => e.name === 'first_drag')).toHaveLength(2);
  });
});
