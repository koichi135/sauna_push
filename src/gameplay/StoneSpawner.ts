import { BALANCE } from '../core/BalanceConfig';
import type { PhysicsWorld, TrackedBody } from '../physics/PhysicsWorld';

/**
 * ストーン投入（仕様 5章）。
 * 画面下部の投入レーンをタップした X 位置から、盤面奥の投入口に出現させる。
 */
export class StoneSpawner {
  private lastThrowSec = -Infinity;
  /** パーク「早業」でクールダウンを縮める倍率。Game が perk 適用時に設定する */
  private cooldownMult = 1;

  constructor(private readonly physics: PhysicsWorld) {}

  setCooldownMult(mult: number): void {
    this.cooldownMult = mult;
  }

  private cooldownSec(fever: boolean): number {
    const base = (fever ? BALANCE.spawn.feverCooldownMs : BALANCE.spawn.cooldownMs) / 1000;
    return base * this.cooldownMult;
  }

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
   * @param bigValueBonus 大玉ストーンの価値への加算（パーク「大玉職人」）
   */
  tryThrow(
    normalizedX: number,
    nowSec: number,
    fever: boolean,
    big = false,
    bigValueBonus = 0,
  ): TrackedBody | null {
    if (nowSec - this.lastThrowSec < this.cooldownSec(fever)) return null;
    this.lastThrowSec = nowSec;

    const maxX = BALANCE.spawn.maxAbsX;
    const x = Math.max(-maxX, Math.min(maxX, normalizedX * maxX));
    return this.physics.spawnStone(
      x,
      BALANCE.spawn.y,
      BALANCE.spawn.z,
      BALANCE.spawn.initialVelocityZ,
      big,
      bigValueBonus,
    );
  }

  /** 現在クールダウン中か（UI の投入レーン表示用） */
  isReady(nowSec: number, fever: boolean): boolean {
    return nowSec - this.lastThrowSec >= this.cooldownSec(fever);
  }

  reset(): void {
    this.lastThrowSec = -Infinity;
    this.cooldownMult = 1;
  }
}
