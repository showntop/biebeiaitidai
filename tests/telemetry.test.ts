import { describe, expect, it } from 'vitest';
import { CompositeTelemetrySink, MemoryTelemetrySink, RunTelemetry } from '../assets/scripts/core/Telemetry';
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
    objectiveLabel: '命中 1 张任务卡',
    objectiveMet: result !== 'lose',
  };
}

describe('RunTelemetry', () => {
  it('组合出口会隔离单个 SDK 故障并继续写入可靠缓冲', () => {
    const delivered = new MemoryTelemetrySink();
    let flushes = 0;
    const sink = new CompositeTelemetrySink([
      { emit: () => { throw new Error('sdk unavailable'); }, flush: () => { throw new Error('flush unavailable'); } },
      delivered,
      { emit: () => undefined, flush: () => { flushes++; } },
    ]);
    const telemetry = new RunTelemetry(sink, {
      sessionId: 'fanout', platform: 'test', deviceTier: 'mid', appVersion: '0.1.0',
    }, () => 1);

    telemetry.runtimeSignal('boot-ok');

    expect(delivered.events.map((event) => event.name)).toEqual(['session_start', 'runtime_signal']);
    expect(flushes).toBe(1);
  });

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
      objectiveMet: false,
      objectiveLabel: '命中 1 张任务卡',
      highlightCount: 0,
      highlightIds: '',
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

  it('高光事件与局末高光摘要使用同一口径', () => {
    const sink = new MemoryTelemetrySink();
    const telemetry = new RunTelemetry(sink, {
      sessionId: 's4', platform: 'test', deviceTier: 'mid', appVersion: '0.1.0',
    }, () => 100);
    telemetry.startLevel(0, 11);
    telemetry.highlight('boss-clutch', 3);
    const runReport = report();
    runReport.highlights = ['clean-hit', 'boss-clutch'];
    runReport.highlightTitle = '门口截胡';
    telemetry.endLevel(runReport);

    expect(sink.events.find((e) => e.name === 'highlight')?.payload).toEqual({ id: 'boss-clutch', tier: 3 });
    expect(sink.events.find((e) => e.name === 'level_end')?.payload).toMatchObject({
      highlightCount: 2,
      highlightIds: 'clean-hit,boss-clutch',
      highlightTitle: '门口截胡',
    });
  });

  it('商业化与运行监控事件不依赖活跃对局也能落盘', () => {
    const sink = new MemoryTelemetrySink();
    const telemetry = new RunTelemetry(sink, {
      sessionId: 's5', platform: 'test', deviceTier: 'low', appVersion: '0.1.0',
    }, () => 10);
    telemetry.rewardedAdResult('revive', 'unavailable');
    telemetry.runtimeSignal('asset-load-failure', 'art/cards/card-key');
    expect(sink.events.find((event) => event.name === 'rewarded_ad_result')?.payload).toEqual({ placement: 'revive', outcome: 'unavailable' });
    expect(sink.events.find((event) => event.name === 'runtime_signal')?.payload).toEqual({ kind: 'asset-load-failure', detail: 'art/cards/card-key' });
  });
});
