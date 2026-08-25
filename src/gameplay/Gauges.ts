import { BALANCE, bandForTemperature, type TempBand } from '../core/BalanceConfig';
import type { EventBus } from '../core/EventBus';

export interface GaugeUpdateContext {
  /** 手持ちストーンが 0（STARVING）か。追加ダメージが入る */
  starving: boolean;
  /** フィーバー中はダメージ0（無敵） */
  fever: boolean;
}

/**
 * 温度・ととのい・体力（仕様 6章）。
 *
 * 設計の要点（仕様 1章）: スコアを稼ぐ行為＝ストーン落下が温度を押し上げる。
 * 「熱い」帯は最高効率だが体力を削り、「灼熱」は倍率が落ちてゴリ押しを潰す。
 * この関係が本作の緊張線なので、帯の意味を変える改修はしないこと。
 */
export class Gauges {
  temperature = BALANCE.temperature.initial;
  totonoi = BALANCE.totonoi.initial;
  stamina = BALANCE.stamina.initial;

  /** ととのいが MAX のまま経過した秒数。autoColdBathSec で自動入水 */
  totonoiFullSec = 0;
  private band: TempBand = bandForTemperature(BALANCE.temperature.initial);
  private warningActive = false;
  /** 直近 payoutWindowSec 以内のペイアウト時刻（ループ内経過秒） */
  private recentPayouts: number[] = [];

  constructor(private readonly bus: EventBus) {}

  get currentBand(): TempBand {
    return this.band;
  }

  get isTotonoiReady(): boolean {
    return this.totonoi >= BALANCE.totonoi.max;
  }

  get isDead(): boolean {
    return this.stamina <= 0;
  }

  /** ペイアウト1個ぶんの温度上昇とととのいボーナスを記録する（仕様 6.1 / 6.2） */
  registerPayout(now: number, count: number): void {
    this.temperature = clamp(
      this.temperature + BALANCE.temperature.gainPerPayout * count,
      BALANCE.temperature.min,
      BALANCE.temperature.max,
    );
    for (let i = 0; i < count; i += 1) this.recentPayouts.push(now);
  }

  /** ロウリュによる温度上昇（仕様 8.1） */
  addTemperature(delta: number): void {
    this.temperature = clamp(
      this.temperature + delta,
      BALANCE.temperature.min,
      BALANCE.temperature.max,
    );
  }

  /** オロポ（仕様 8.2） */
  addStamina(delta: number): void {
    this.stamina = clamp(this.stamina + delta, 0, BALANCE.stamina.max);
  }

  /** 水風呂（仕様 6.1 / 7.1） */
  applyColdBath(): void {
    this.temperature = BALANCE.temperature.afterColdBath;
  }

  /** フィーバー終了時（仕様 6.2） */
  resetTotonoi(): void {
    this.totonoi = 0;
    this.totonoiFullSec = 0;
  }

  update(dt: number, now: number, ctx: GaugeUpdateContext): void {
    this.updateTemperature(dt);
    this.updateTotonoi(dt, now);
    this.updateStamina(dt, ctx);
  }

  private updateTemperature(dt: number): void {
    const prev = this.band;
    this.temperature = clamp(
      this.temperature + BALANCE.temperature.coolPerSec * dt,
      BALANCE.temperature.min,
      BALANCE.temperature.max,
    );
    const next = bandForTemperature(this.temperature);
    if (next.id !== prev.id) {
      this.band = next;
      this.bus.emit('BAND_CHANGED', { from: prev.id, to: next.id });
    }
  }

  private updateTotonoi(dt: number, now: number): void {
    // 窓から出た古いペイアウトを捨てる
    const cutoff = now - BALANCE.totonoi.payoutWindowSec;
    while (this.recentPayouts.length > 0 && (this.recentPayouts[0] as number) < cutoff) {
      this.recentPayouts.shift();
    }

    const wasReady = this.totonoi >= BALANCE.totonoi.max;
    const gainPerSec =
      BALANCE.totonoi.basePerSec * this.band.totonoiMultiplier +
      BALANCE.totonoi.payoutBonusPerSec * this.recentPayouts.length;
    this.totonoi = clamp(this.totonoi + gainPerSec * dt, 0, BALANCE.totonoi.max);

    if (this.totonoi >= BALANCE.totonoi.max) {
      if (!wasReady) {
        this.totonoiFullSec = 0;
        this.bus.emit('TOTONOI_READY', {});
      } else {
        this.totonoiFullSec += dt;
      }
    }
  }

  private updateStamina(dt: number, ctx: GaugeUpdateContext): void {
    if (!ctx.fever) {
      // 高温帯のダメージと STARVING は加算される（仕様 6.3）
      let perSec = this.band.staminaPerSec;
      if (ctx.starving) perSec += BALANCE.stamina.starvingPerSec;
      this.stamina = clamp(this.stamina + perSec * dt, 0, BALANCE.stamina.max);
    }

    const warn = this.stamina <= BALANCE.stamina.max * BALANCE.stamina.warningRatio;
    if (warn !== this.warningActive) {
      this.warningActive = warn;
      this.bus.emit('STAMINA_WARNING', { active: warn });
    }
  }

  reset(): void {
    this.temperature = BALANCE.temperature.initial;
    this.totonoi = BALANCE.totonoi.initial;
    this.stamina = BALANCE.stamina.initial;
    this.totonoiFullSec = 0;
    this.band = bandForTemperature(this.temperature);
    this.warningActive = false;
    this.recentPayouts = [];
  }
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}
