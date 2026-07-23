import type { RunReport } from './RunReport';
import type { HighlightId, HighlightTier, HitQuality, PropType } from './types';

export type TelemetryEventName =
  | 'session_start'
  | 'level_start'
  | 'level_end'
  | 'tutorial_shown'
  | 'prop_hold_started'
  | 'first_drag'
  | 'first_release'
  | 'first_valid_hit'
  | 'first_perfect'
  | 'first_manual_throw'
  | 'target_changed'
  | 'release_noop'
  | 'tutorial_completed'
  | 'invalid_target'
  | 'gesture_cancel'
  | 'approval_zone_changed'
  | 'boss_warning'
  | 'highlight'
  | 'revive_used'
  | 'result_type'
  | 'fail_reason'
  | 'retry'
  | 'next_level'
  | 'return_home'
  | 'share_open'
  | 'share_result'
  | 'challenge_start'
  | 'rewarded_ad_result'
  | 'runtime_signal';

export type TelemetryValue = string | number | boolean | null;
export type TelemetryPayload = Record<string, TelemetryValue>;

export interface TelemetryEvent {
  name: TelemetryEventName;
  timestampMs: number;
  sequence: number;
  sessionId: string;
  runId: string | null;
  levelIndex: number | null;
  platform: string;
  deviceTier: string;
  payload: TelemetryPayload;
}

export interface TelemetrySink {
  emit(event: TelemetryEvent): void;
  flush?(): void;
}

export interface TelemetryContext {
  sessionId: string;
  platform: string;
  deviceTier: string;
  appVersion: string;
}

export type FailReason = 'unhandled-task' | 'boss-inspection' | 'unknown';

interface ActiveRun {
  runId: string;
  levelIndex: number;
  seed: number;
  startedAtMs: number;
  firstKeys: Set<string>;
  frameFps: number[];
  releases: number;
  hits: number;
  perfects: number;
  invalidTargets: number;
  cancels: number;
  targetSwitches: number;
  manualThrows: number;
  releaseNoops: number;
  firstHitMs: number | null;
  propUses: Record<PropType, number>;
}

export class MemoryTelemetrySink implements TelemetrySink {
  readonly events: TelemetryEvent[] = [];
  emit(event: TelemetryEvent): void {
    this.events.push(event);
  }
}

/**
 * 将同一事件安全地扇出到本地缓冲、平台分析和第三方 SDK。
 * 任一出口失败都不会阻断游戏，也不会影响其他出口收到事件。
 */
export class CompositeTelemetrySink implements TelemetrySink {
  constructor(private readonly sinks: readonly TelemetrySink[]) {}

  emit(event: TelemetryEvent): void {
    for (const sink of this.sinks) {
      try { sink.emit(event); } catch { /* 埋点出口必须彼此隔离 */ }
    }
  }

  flush(): void {
    for (const sink of this.sinks) {
      try { sink.flush?.(); } catch { /* 上报失败不阻断结算和导航 */ }
    }
  }
}

/**
 * 平台无关的最小埋点状态机。它负责首个事件去重和局末指标聚合，平台层只负责落盘/上报。
 */
export class RunTelemetry {
  private sequence = 0;
  private runSequence = 0;
  private activeRun: ActiveRun | null = null;
  private lastRunContext: { runId: string; levelIndex: number } | null = null;

  constructor(
    private readonly sink: TelemetrySink,
    private readonly context: TelemetryContext,
    private readonly clock: () => number = () => Date.now(),
  ) {
    this.emit('session_start', { appVersion: context.appVersion });
  }

  startLevel(levelIndex: number, seed: number): void {
    const now = this.clock();
    const runId = `${this.context.sessionId}-${++this.runSequence}`;
    this.activeRun = {
      runId,
      levelIndex,
      seed: seed >>> 0,
      startedAtMs: now,
      firstKeys: new Set(),
      frameFps: [],
      releases: 0,
      hits: 0,
      perfects: 0,
      invalidTargets: 0,
      cancels: 0,
      targetSwitches: 0,
      manualThrows: 0,
      releaseNoops: 0,
      firstHitMs: null,
      propUses: {
        'add-demand': 0,
        'change-demand': 0,
        'throw-pot': 0,
        'kiss-up': 0,
      },
    };
    this.emit('level_start', { seed: seed >>> 0 });
  }

  tutorialShown(step: number): void {
    this.emit('tutorial_shown', { step });
  }

  propHoldStarted(prop: PropType): void {
    this.emit('prop_hold_started', { prop });
  }

  dragStarted(): void {
    this.emitFirst('first_drag', 'first-drag', { sinceLevelStartMs: this.sinceStartMs() });
  }

  manualThrowStarted(prop: PropType): void {
    const run = this.activeRun;
    if (!run) return;
    run.manualThrows++;
    this.emitFirst('first_manual_throw', 'first-manual-throw', { prop, sinceLevelStartMs: this.sinceStartMs() });
  }

  targetChanged(prop: PropType, fromSlot: number, toSlot: number): void {
    const run = this.activeRun;
    if (!run || fromSlot === toSlot) return;
    run.targetSwitches++;
    this.emit('target_changed', { prop, fromSlot, toSlot });
  }

  releaseNoop(prop: PropType, reason: string): void {
    const run = this.activeRun;
    if (!run) return;
    run.releaseNoops++;
    this.emit('release_noop', { prop, reason });
  }

  tutorialCompleted(step: number): void {
    this.emitFirst('tutorial_completed', 'tutorial-completed', { step, sinceLevelStartMs: this.sinceStartMs() });
  }

  released(prop: PropType): void {
    const run = this.activeRun;
    if (!run) return;
    run.releases++;
    run.propUses[prop]++;
    this.emitFirst('first_release', 'first-release', { prop, sinceLevelStartMs: this.sinceStartMs() });
  }

  validHit(prop: PropType, quality: HitQuality): void {
    const run = this.activeRun;
    if (!run) return;
    run.hits++;
    if (run.firstHitMs === null) run.firstHitMs = this.sinceStartMs();
    this.emitFirst('first_valid_hit', 'first-valid-hit', {
      prop,
      quality,
      sinceLevelStartMs: run.firstHitMs,
    });
    if (quality === 'perfect') {
      run.perfects++;
      this.emitFirst('first_perfect', 'first-perfect', { prop, sinceLevelStartMs: this.sinceStartMs() });
    }
  }

  invalidTarget(prop: PropType, reason: string): void {
    if (!this.activeRun) return;
    this.activeRun.invalidTargets++;
    this.emit('invalid_target', { prop, reason });
  }

  gestureCanceled(prop: PropType): void {
    if (!this.activeRun) return;
    this.activeRun.cancels++;
    this.emit('gesture_cancel', { prop });
  }

  approvalZoneChanged(from: string, to: string): void {
    this.emit('approval_zone_changed', { from, to });
  }

  bossWarning(tier: number, slot: number): void {
    this.emit('boss_warning', { tier, slot });
  }

  reviveUsed(): void {
    this.emit('revive_used', {});
  }

  highlight(id: HighlightId, tier: HighlightTier): void {
    this.emit('highlight', { id, tier });
  }

  challengeStarted(mode: string, code: string): void {
    this.emit('challenge_start', { mode, code });
  }

  shareOpened(variant: string): void {
    this.emit('share_open', { variant });
  }

  shareResult(outcome: string): void {
    this.emit('share_result', { outcome });
    this.sink.flush?.();
  }

  rewardedAdResult(placement: string, outcome: string): void {
    this.emit('rewarded_ad_result', { placement, outcome });
    this.sink.flush?.();
  }

  runtimeSignal(kind: string, detail: string | null = null): void {
    this.emit('runtime_signal', { kind, detail });
    this.sink.flush?.();
  }

  navigation(name: 'retry' | 'next_level' | 'return_home'): void {
    this.emit(name, {});
    this.sink.flush?.();
  }

  sampleFrame(dtSec: number): void {
    const run = this.activeRun;
    if (!run || dtSec <= 0 || dtSec > 1 || run.frameFps.length >= 3600) return;
    run.frameFps.push(Math.min(240, 1 / dtSec));
  }

  endLevel(report: RunReport, failReason: FailReason = 'unknown'): void {
    const run = this.activeRun;
    if (!run) return;
    this.emit('result_type', { result: report.result, stars: report.stars });
    if (report.result === 'lose') this.emit('fail_reason', { reason: failReason });

    const releaseAttempts = run.releases + run.cancels;
    this.emit('level_end', {
      result: report.result,
      stars: report.stars,
      durationMs: Math.max(0, this.clock() - run.startedAtMs),
      firstHitMs: run.firstHitMs,
      effectiveHits: run.hits,
      releases: run.releases,
      invalidTargets: run.invalidTargets,
      cancels: run.cancels,
      targetSwitches: run.targetSwitches,
      manualThrows: run.manualThrows,
      releaseNoops: run.releaseNoops,
      hitRate: ratio(run.hits, run.releases),
      perfectRate: ratio(run.perfects, run.hits),
      cancelRate: ratio(run.cancels, releaseAttempts),
      fpsP50: percentile(run.frameFps, 0.50),
      fpsP10: percentile(run.frameFps, 0.10),
      peakApproval: report.peakApproval,
      finalApproval: report.finalApproval,
      objectiveMet: report.objectiveMet ?? null,
      objectiveLabel: report.objectiveLabel ?? null,
      highlightCount: report.highlights?.length ?? 0,
      highlightIds: report.highlights?.join(',') ?? '',
      highlightTitle: report.highlightTitle ?? null,
      addDemandUses: run.propUses['add-demand'],
      changeDemandUses: run.propUses['change-demand'],
      throwPotUses: run.propUses['throw-pot'],
      kissUpUses: run.propUses['kiss-up'],
    });
    this.sink.flush?.();
    this.lastRunContext = { runId: run.runId, levelIndex: run.levelIndex };
    this.activeRun = null;
  }

  private emitFirst(name: TelemetryEventName, key: string, payload: TelemetryPayload): void {
    const run = this.activeRun;
    if (!run || run.firstKeys.has(key)) return;
    run.firstKeys.add(key);
    this.emit(name, payload);
  }

  private sinceStartMs(): number {
    return this.activeRun ? Math.max(0, this.clock() - this.activeRun.startedAtMs) : 0;
  }

  private emit(name: TelemetryEventName, payload: TelemetryPayload): void {
    const run = this.activeRun;
    const runContext = run ?? this.lastRunContext;
    this.sink.emit({
      name,
      timestampMs: this.clock(),
      sequence: ++this.sequence,
      sessionId: this.context.sessionId,
      runId: runContext?.runId ?? null,
      levelIndex: runContext?.levelIndex ?? null,
      platform: this.context.platform,
      deviceTier: this.context.deviceTier,
      payload,
    });
  }
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? Number((numerator / denominator).toFixed(4)) : 0;
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p)));
  return Number(sorted[index].toFixed(1));
}
