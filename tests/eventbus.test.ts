import { describe, expect, it } from 'vitest';
import { EventBus } from '../assets/scripts/core/EventBus';

describe('EventBus', () => {
  it('按订阅顺序调用事件处理函数', () => {
    const bus = new EventBus();
    const calls: number[] = [];
    bus.on('CardShifted', () => calls.push(1));
    bus.on('CardShifted', () => calls.push(2));

    bus.emit('CardShifted', { tickIndex: 1 });

    expect(calls).toEqual([1, 2]);
  });

  it('回调中取消订阅不影响当前快照，下一次触发时生效', () => {
    const bus = new EventBus();
    const calls: string[] = [];
    let removeSecond = () => {};
    bus.on('CardShifted', () => {
      calls.push('first');
      removeSecond();
    });
    removeSecond = bus.on('CardShifted', () => calls.push('second'));

    bus.emit('CardShifted', { tickIndex: 1 });
    bus.emit('CardShifted', { tickIndex: 2 });

    expect(calls).toEqual(['first', 'second', 'first']);
  });
});
