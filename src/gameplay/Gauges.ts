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
  /** サウナハットの耐熱の残り秒数。0 より大きい間は温度帯ダメージを受けない */
  heatShieldSec = 0;
  /** セット数による難度スケール。setDifficulty で更新 */
  private coolScale = 1;
  private damageScale = 1;
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

  /** 砂時計（フィーバー外） */
  addTotonoi(delta: number): void {
    this.totonoi = clamp(this.totonoi + delta, 0, BALANCE.totonoi.max);
  }

  /** サウナハット。既に耐熱中なら残り時間を上書き延長する */
  addHeatShield(seconds: number): void {
    const wasActive = this.heatShieldSec > 0;
    this.heatShieldSec = Math.max(this.heatShieldSec, seconds);
    if (!wasActive) this.bus.emit('HEAT_SHIELD', { active: true, seconds });
  }

  get hasHeatShield(): boolean {
    return this.heatShieldSec > 0;
  }

  /**
   * 難度レベル（セット数 + 経過時間）に応じて放熱とダメージを強める（BALANCE.sets）。
   * エンドレスの緩やかな難度上昇。倍率は上限で頭打ち。
   */
  setDifficulty(level: number): void {
    const d = BALANCE.sets;
    this.coolScale = Math.min(d.coolingMax, 1 + d.coolingPerSet * level);
    this.damageScale = Math.min(d.damageMax, 1 + d.damagePerSet * level);
  }

  get coolingScale(): number {
    return this.coolScale;
  }

  get damageScaleValue(): number {
    return this.damageScale;
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
      this.temperature + BALANCE.temperature.coolPerSec * this.coolScale * dt,
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
    if (this.heatShieldSec > 0) {
      this.heatShieldSec = Math.max(0, this.heatShieldSec - dt);
      if (this.heatShieldSec <= 0) this.bus.emit('HEAT_SHIELD', { active: false, seconds: 0 });
    }

    if (ctx.fever) {
      // 外気浴で回復する。熱い帯で粘って入水するほど外気浴が長く、回復も多い
      this.stamina = clamp(
        this.stamina + BALANCE.fever.staminaRegenPerSec * dt,
        0,
        BALANCE.stamina.max,
      );
    } else {
      // 温度帯のダメージと STARVING は加算される（仕様 6.3）。
      // ダメージ（負値）だけ難度レベルでスケールし、適温の回復は据え置き。
      // サウナハット中はダメージ無効。STARVING は常に効く。
      const bandPerSec = this.band.staminaPerSec;
      let perSec = bandPerSec < 0 ? (this.heatShieldSec > 0 ? 0 : bandPerSec * this.damageScale) : bandPerSec;
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
    this.heatShieldSec = 0;
    this.coolScale = 1;
    this.damageScale = 1;
    this.band = bandForTemperature(this.temperature);
    this.warningActive = false;
    this.recentPayouts = [];
  }
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}
