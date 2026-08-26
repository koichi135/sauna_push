import { BALANCE } from '../core/BalanceConfig';

/**
 * ロウリュ（常設ボタン＋クールタイム制）。
 *
 * ボタンを押すとロウリュモードに入り、盤面をタップすると水をかける。
 * 水がかかったストーンは濡れて黒くなり、一定時間 蒸気を上げ続け、
 * その間だけ室温が上がる。かけた瞬間に温度が跳ねるのではなく
 * 「濡れている間じわじわ上がる」ので、どこにかけて何個濡らせるかが効きを決める。
 */
export class LoylyController {
  private cooldownRemaining = 0;
  private modeRemaining = 0;

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
    return this.cooldownRemaining / BALANCE.loyly.cooldownSec;
  }

  get cooldownRemainingSec(): number {
    return this.cooldownRemaining;
  }

  /** ロウリュモードの残り時間の割合 1..0 */
  get modeRatio(): number {
    return this.modeRemaining / BALANCE.loyly.modeTimeoutSec;
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
    this.cooldownRemaining = BALANCE.loyly.cooldownSec;
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
  }
}
