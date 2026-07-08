import type { GameEvents } from './types';

type EventName = keyof GameEvents;
type Handler<K extends EventName> = (payload: GameEvents[K]) => void;

/**
 * 类型安全的发布订阅（事件总线）。
 *
 * core 各系统通过它解耦：数值判定层（Conveyor/Prop/Approval）只发事件，
 * 表现层（AIActor/UI/Audio）只订阅事件、不回写判定（开发计划§2 关键原则）。
 * 同一套事件契约，两个消费者：单测（断言）与 Cocos 表现层（驱动节点）。
 *
 * 实现说明：内部存储用宽松类型（不同事件的 handler 混存于 Set），
 * 公共 API（on/emit）仍按 K 严格参数化，保证调用方类型安全。
 */
export class EventBus {
  private handlers = new Map<EventName, Set<(payload: unknown) => void>>();

  /** 订阅，返回取消订阅函数。 */
  on<K extends EventName>(name: K, handler: Handler<K>): () => void {
    let set = this.handlers.get(name);
    if (!set) {
      set = new Set();
      this.handlers.set(name, set);
    }
    set.add(handler as (payload: unknown) => void);
    return () => this.off(name, handler);
  }

  off<K extends EventName>(name: K, handler: Handler<K>): void {
    this.handlers.get(name)?.delete(handler as (payload: unknown) => void);
  }

  /** 只触发一次。 */
  once<K extends EventName>(name: K, handler: Handler<K>): () => void {
    const unsub = this.on(name, (payload) => {
      unsub();
      handler(payload);
    });
    return unsub;
  }

  emit<K extends EventName>(name: K, payload: GameEvents[K]): void {
    const set = this.handlers.get(name);
    if (!set || set.size === 0) return;
    // 拷贝一份再遍历，防止回调中 off/on 导致迭代异常。
    for (const h of [...set]) (h as Handler<K>)(payload);
  }

  clear(): void {
    this.handlers.clear();
  }
}
