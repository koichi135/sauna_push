import { BALANCE } from '../core/BalanceConfig';

/**
 * ロウリュ（常設ボタン＋クールタイム制）。
 *
 * FB「存在意義がわからない死に仕様」への対応で全面変更した。
 * ボタンを押すとロウリュモードに入り、盤面をタップすると狙った地点の山へ
 * 即座に衝撃を与えて手前へ押し出す（ヴィヒタの局所版）。押し出されたストーンは
 * 0.4 秒のコンボ窓に乗るので、「詰まった山をロウリュでほぐしてコンボにする」が
 * 攻略の核になる。副次効果として軽く濡れて温度も少し上がる。
 */
export class LoylyController {
  private cooldownRemaining = 0;
  private modeRemaining = 0;
  /** パーク「ロウリュ達人」でクールダウンを縮める倍率。Game が perk 適用時に設定する */
  private cooldownMult = 1;

  /** ロウリュモード中か */
  get isActive(): boolean {
    return this.modeRemaining > 0;
  }

  /** クールタイムが明けていて使えるか */
  get isReady(): boolean {
    return this.cooldownRemaining <= 0;
  }

  /** クールタイムの進捗 0（明け）..1（使った直後）。ボタンの残量表示用 */
  get cooldownRatio(): number {
    return this.cooldownRemaining / (BALANCE.loyly.cooldownSec * this.cooldownMult);
  }

  get cooldownRemainingSec(): number {
    return this.cooldownRemaining;
  }

  /** ロウリュモードの残り時間の割合 1..0 */
  get modeRatio(): number {
    return this.modeRemaining / BALANCE.loyly.modeTimeoutSec;
  }

  setCooldownMult(mult: number): void {
    this.cooldownMult = mult;
  }

  /** モードに入る。クールタイム中なら false */
  tryActivate(): boolean {
    if (!this.isReady || this.isActive) return false;
    this.modeRemaining = BALANCE.loyly.modeTimeoutSec;
    return true;
  }

  /** 水をかけずにモードを抜ける。クールタイムは消費しない */
  cancel(): void {
    this.modeRemaining = 0;
  }

  /** 水をかけた。モードを抜けてクールタイムに入る */
  consume(): void {
    this.modeRemaining = 0;
    this.cooldownRemaining = BALANCE.loyly.cooldownSec * this.cooldownMult;
  }

  /**
   * 固定ステップで進める。
   * モードが時間切れになった瞬間だけ 'timeout' を返す。
   */
  update(dt: number): 'none' | 'timeout' {
    if (this.cooldownRemaining > 0) {
      this.cooldownRemaining = Math.max(0, this.cooldownRemaining - dt);
    }
    if (this.modeRemaining > 0) {
      this.modeRemaining = Math.max(0, this.modeRemaining - dt);
      if (this.modeRemaining <= 0) return 'timeout';
    }
    return 'none';
  }

  reset(): void {
    this.cooldownRemaining = 0;
    this.modeRemaining = 0;
    this.cooldownMult = 1;
  }
}
