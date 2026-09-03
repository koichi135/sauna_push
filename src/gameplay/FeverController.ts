import { BALANCE } from '../core/BalanceConfig';
import { clamp } from './Gauges';

/**
 * 水風呂とフィーバー（仕様 7章、採用案A）。
 *
 * 案Aの肝: 「ボタンが点いてから、体力を削りながら何秒温度を上げ続けられるか」の
 * チキンレース。入水した瞬間の温度がそのまま倍率と継続時間になる。
 * 盤面に水風呂穴を作る案B・ミニゲーム化する案C は不採用（実装しないこと）。
 */

export interface FeverParams {
  multiplier: number;
  duration: number;
}

/** 入水時の温度から倍率と継続時間を求める（仕様 7.1） */
export function feverParamsFor(temperature: number): FeverParams {
  const f = BALANCE.fever;
  const t = (temperature - f.refTemp) / f.tempSpan;
  return {
    multiplier: clamp(1.0 + t * f.multiplierGain, f.multiplierMin, f.multiplierMax),
    duration: clamp(f.baseDurationSec + t * f.durationGain, f.durationMin, f.durationMax),
  };
}

export type FeverPhase = 'idle' | 'coldBath' | 'fever';

export class FeverController {
  private phase: FeverPhase = 'idle';
  private timer = 0;
  private params: FeverParams = { multiplier: 1, duration: 0 };
  /** 自動移行（ボーナスなし）で入水したか */
  private auto = false;
  /**
   * 砂時計の永続レリック効果によるフィーバー継続時間の加算（秒）。
   * 拾うたびに増え、以後ずっと手動入水の外気浴が長くなる。自動入水には効かない。
   */
  relicDurationBonusSec = 0;

  get currentPhase(): FeverPhase {
    return this.phase;
  }

  get isFever(): boolean {
    return this.phase === 'fever';
  }

  get isColdBath(): boolean {
    return this.phase === 'coldBath';
  }

  /** フィーバー中でなければ 1.0 */
  get multiplier(): number {
    return this.phase === 'fever' ? this.params.multiplier : 1;
  }

  /** フィーバーの残り時間（UI 用） */
  get remaining(): number {
    return this.phase === 'fever' ? Math.max(0, this.params.duration - this.timer) : 0;
  }

  get progress(): number {
    if (this.phase === 'coldBath') return this.timer / BALANCE.fever.coldBathSec;
    if (this.phase === 'fever') return this.params.duration > 0 ? this.timer / this.params.duration : 1;
    return 0;
  }

  get pendingParams(): FeverParams {
    return this.params;
  }

  get enteredAutomatically(): boolean {
    return this.auto;
  }

  /**
   * 入水する。
   * @param temperature 入水直前の温度。これが倍率になる
   * @param auto MAX放置による自動移行なら true（ボーナスなし）
   * @param perkDurationBonusSec パーク「長湯」による継続時間の加算（秒）。auto では効かない
   */
  enterColdBath(temperature: number, auto: boolean, perkDurationBonusSec = 0): FeverParams {
    this.phase = 'coldBath';
    this.timer = 0;
    this.auto = auto;
    if (auto) {
      this.params = { multiplier: BALANCE.fever.autoMultiplier, duration: BALANCE.fever.autoDurationSec };
    } else {
      const base = feverParamsFor(temperature);
      this.params = {
        multiplier: base.multiplier,
        duration: base.duration + perkDurationBonusSec + this.relicDurationBonusSec,
      };
    }
    return this.params;
  }

  /**
   * 固定ステップで進める。
   * フェーズが切り替わった瞬間に 'feverStart' / 'feverEnd' を返す。
   */
  update(dt: number): 'none' | 'feverStart' | 'feverEnd' {
    if (this.phase === 'idle') return 'none';
    this.timer += dt;

    if (this.phase === 'coldBath') {
      if (this.timer >= BALANCE.fever.coldBathSec) {
        this.phase = 'fever';
        this.timer = 0;
        return 'feverStart';
      }
      return 'none';
    }

    if (this.timer >= this.params.duration) {
      this.phase = 'idle';
      this.timer = 0;
      this.auto = false;
      return 'feverEnd';
    }
    return 'none';
  }

  reset(): void {
    this.phase = 'idle';
    this.timer = 0;
    this.auto = false;
    this.relicDurationBonusSec = 0;
    this.params = { multiplier: 1, duration: 0 };
  }
}
