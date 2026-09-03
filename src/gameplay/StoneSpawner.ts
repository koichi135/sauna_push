import { BALANCE } from '../core/BalanceConfig';
import type { PhysicsWorld, TrackedBody } from '../physics/PhysicsWorld';

/**
 * ストーン投入（仕様 5章）。
 * 画面下部の投入レーンをタップした X 位置から、盤面奥の投入口に出現させる。
 */
export class StoneSpawner {
  private lastThrowSec = -Infinity;

  constructor(private readonly physics: PhysicsWorld) {}

  /**
   * 投入を試みる。クールダウン中なら null。
   * 手持ちストーンの消費は呼び出し側（Game）が行う。
   *
   * 時刻は実時間ではなくゲーム内時間で測る。実時間だと PAUSED 中にクールダウンが
   * 明けてしまい、スローモーション中は逆に連射できてしまう。
   *
   * @param normalizedX -1..1 の投入レーン上の位置
   * @param nowSec GameLoop.now（ゲーム内経過秒）
   * @param big 大玉ストーンとして投入する
   */
  tryThrow(normalizedX: number, nowSec: number, fever: boolean, big = false): TrackedBody | null {
    const cooldown = (fever ? BALANCE.spawn.feverCooldownMs : BALANCE.spawn.cooldownMs) / 1000;
    if (nowSec - this.lastThrowSec < cooldown) return null;
    this.lastThrowSec = nowSec;

    const maxX = BALANCE.spawn.maxAbsX;
    const x = Math.max(-maxX, Math.min(maxX, normalizedX * maxX));
    return this.physics.spawnStone(x, BALANCE.spawn.y, BALANCE.spawn.z, BALANCE.spawn.initialVelocityZ, big);
  }

  /** 現在クールダウン中か（UI の投入レーン表示用） */
  isReady(nowSec: number, fever: boolean): boolean {
    const cooldown = (fever ? BALANCE.spawn.feverCooldownMs : BALANCE.spawn.cooldownMs) / 1000;
    return nowSec - this.lastThrowSec >= cooldown;
  }

  reset(): void {
    this.lastThrowSec = -Infinity;
  }
}
