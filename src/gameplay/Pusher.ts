import { BALANCE } from '../core/BalanceConfig';
import type { PhysicsWorld } from '../physics/PhysicsWorld';

/**
 * プッシャーの往復運動（仕様 4章）。
 *   z = baseZ + stroke * 0.5 * (1 - cos(2π * t / period))
 *
 * 通常時とフィーバー時で period が変わるが、位相を保存して連続的に切り替える。
 * 位相 phase (0..1) を直接進めることで、period 変更時に z が飛ばない。
 */
export class Pusher {
  /** 0..1 の正規化位相 */
  private phase = 0;
  private stopped = false;
  /** パーク「太い腕」でストロークを伸ばす倍率。Game が perk 適用時に設定する */
  private strokeMult = 1;

  constructor(private readonly physics: PhysicsWorld) {
    this.physics.setPusherZ(this.zForPhase(0));
  }

  /** 入水演出中はプッシャーを止める（仕様 7.1） */
  setStopped(stopped: boolean): void {
    this.stopped = stopped;
  }

  setStrokeMult(mult: number): void {
    this.strokeMult = mult;
  }

  update(dt: number, fever: boolean): void {
    if (this.stopped) return;
    const period = fever ? BALANCE.pusher.feverPeriod : BALANCE.pusher.period;
    // 位相を進める。period が変わっても phase は連続なので z は飛ばない。
    this.phase = (this.phase + dt / period) % 1;
    this.physics.setPusherZ(this.zForPhase(this.phase));
  }

  /** 押し板の前面 Z。ロウリュの着弾可能範囲などの判定に使う。 */
  get frontZ(): number {
    return this.physics.getPusherZ() - BALANCE.pusher.depth / 2;
  }

  private zForPhase(phase: number): number {
    const { baseZ, stroke } = BALANCE.pusher;
    return baseZ + stroke * this.strokeMult * 0.5 * (1 - Math.cos(2 * Math.PI * phase));
  }

  reset(): void {
    this.phase = 0;
    this.stopped = false;
    this.strokeMult = 1;
    this.physics.setPusherZ(this.zForPhase(0));
  }
}
