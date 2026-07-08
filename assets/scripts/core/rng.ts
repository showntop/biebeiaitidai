/**
 * 可注入随机源。
 *
 * 规则层必须支持【确定性模拟】：把 RNG 抽成接口注入，
 * 测试/千局模拟用 SeededRng 复现，正式运行用 defaultRng(Math.random)。
 * 这是 M0 验收"回归比对"的基础——同样种子→同样序列→可断言。
 */
export interface Rng {
  /** 返回 [0,1) 随机数 */
  next(): number;
  /** 按概率密度选一个（密度之和应为1，否则截断回退末项） */
  pick<T>(items: readonly T[]): T;
}

class MathRng implements Rng {
  next(): number {
    return Math.random();
  }
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(Math.random() * items.length)] ?? items[0];
  }
}

export const defaultRng: Rng = new MathRng();

/** 确定性随机（Numerical Recipes LCG），同种子同序列，用于测试与模拟。 */
export class SeededRng implements Rng {
  private state: number;
  constructor(seed: number) {
    this.state = (seed >>> 0) || 1;
  }
  next(): number {
    this.state = (Math.imul(this.state, 1664525) + 1013904223) >>> 0;
    return this.state / 4294967296;
  }
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)] ?? items[0];
  }
}
