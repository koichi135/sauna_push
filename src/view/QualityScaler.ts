import { BALANCE } from '../core/BalanceConfig';
import type { EventBus } from '../core/EventBus';

/**
 * 品質オートスケール（仕様 3章 性能予算）。
 * 30fps を 2秒間下回ったらパーティクル密度を1段階落とす。
 *
 * 一度落とした品質は上げ直さない。上げ下げを繰り返すとその判定自体が
 * ちらつきとして見えてしまうため。
 */
export class QualityScaler {
  private step = 0;
  private belowSec = 0;

  constructor(private readonly bus: EventBus) {}

  get currentStep(): number {
    return this.step;
  }

  /** パーティクル密度などに掛ける倍率 */
  get scale(): number {
    const steps = BALANCE.view.qualitySteps;
    return steps[Math.min(this.step, steps.length - 1)] ?? 1;
  }

  /** 陽炎パスを出すかどうか。品質を落とした時点で切る */
  get allowDistortion(): boolean {
    return this.step <= 1;
  }

  get canDegrade(): boolean {
    return this.step < BALANCE.view.qualitySteps.length - 1;
  }

  update(frameDt: number, fps: number): void {
    if (!this.canDegrade) return;
    if (fps < BALANCE.view.fpsFloor) {
      this.belowSec += frameDt;
      if (this.belowSec >= BALANCE.view.degradeAfterSec) {
        this.step += 1;
        this.belowSec = 0;
        this.bus.emit('QUALITY_CHANGED', { step: this.step });
      }
    } else {
      this.belowSec = 0;
    }
  }

  /** デバッグパネルからの手動設定 */
  setStep(step: number): void {
    this.step = Math.max(0, Math.min(step, BALANCE.view.qualitySteps.length - 1));
    this.bus.emit('QUALITY_CHANGED', { step: this.step });
  }
}
