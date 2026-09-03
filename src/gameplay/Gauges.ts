import { BALANCE, bandForTemperature, type TempBand } from '../core/BalanceConfig';
import type { EventBus } from '../core/EventBus';
import type { RunModifiers } from './RunModifiers';

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
  /** セット数による難度スケール。setDifficulty で更新 */
  private coolScale = 1;
  private damageScale = 1;
  /** サウナハット・レリックのスタックによる温度帯ダメージ倍率（乗算で重なる。1 が無効） */
  private relicDamageMult = 1;
  /** サウナハットのスタック数（HUD 表示用） */
  relicDamageStacks = 0;
  /** パーク由来の倍率・加算値。Game が resetRun/perk 適用時に反映する */
  private runDamageMult = 1;
  private runMaxBonus = 0;
  private runFeverRegenMult = 1;
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

  /** 最大体力。パーク「頑丈な体」の加算ぶんを含む */
  get maxStamina(): number {
    return BALANCE.stamina.max + this.runMaxBonus;
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
    this.stamina = clamp(this.stamina + delta, 0, this.maxStamina);
  }

  /**
   * サウナハットの永続レリック効果。拾うたびにスタックし、温度帯ダメージを
   * 乗算で継続的に軽減する（旧仕様の一時無効化から変更。README 参照）。
   */
  addRelicDamageResist(multPerStack: number): void {
    this.relicDamageMult *= multPerStack;
    this.relicDamageStacks += 1;
  }

  /**
   * パーク選択で決まる倍率・加算をまとめて反映する。ラン中に選ぶたびに呼ばれる。
   * ここで受け取った値は毎ステップ再計算せず保持するだけなので、
   * BALANCE と違って「常に読み直す」制約の対象外（更新頻度が低いパークの都合上のキャッシュ）。
   */
  setRunModifiers(mods: RunModifiers): void {
    const prevMaxBonus = this.runMaxBonus;
    this.runDamageMult = mods.staminaDamageMult;
    this.runMaxBonus = mods.staminaMaxBonus;
    this.runFeverRegenMult = mods.feverRegenMult;
    // 最大体力が増えたぶんはそのまま即座に回復させる（パーク「頑丈な体」）
    const grew = this.runMaxBonus - prevMaxBonus;
    if (grew > 0) this.stamina = clamp(this.stamina + grew, 0, this.maxStamina);
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
    if (ctx.fever) {
      // 外気浴で回復する。熱い帯で粘って入水するほど外気浴が長く、回復も多い
      this.stamina = clamp(
        this.stamina + BALANCE.fever.staminaRegenPerSec * this.runFeverRegenMult * dt,
        0,
        this.maxStamina,
      );
    } else {
      // 温度帯のダメージと STARVING は加算される（仕様 6.3）。
      // ダメージ（負値）だけ難度レベル・サウナハットのレリック・パークでスケールし、
      // 適温の回復は据え置き。STARVING は常に効く。
      const bandPerSec = this.band.staminaPerSec;
      let perSec =
        bandPerSec < 0
          ? bandPerSec * this.damageScale * this.relicDamageMult * this.runDamageMult
          : bandPerSec;
      if (ctx.starving) perSec += BALANCE.stamina.starvingPerSec;
      this.stamina = clamp(this.stamina + perSec * dt, 0, this.maxStamina);
    }

    const warn = this.stamina <= this.maxStamina * BALANCE.stamina.warningRatio;
    if (warn !== this.warningActive) {
      this.warningActive = warn;
      this.bus.emit('STAMINA_WARNING', { active: warn });
    }
  }

  reset(): void {
    this.temperature = BALANCE.temperature.initial;
    this.totonoi = BALANCE.totonoi.initial;
    this.coolScale = 1;
    this.damageScale = 1;
    this.relicDamageMult = 1;
    this.relicDamageStacks = 0;
    this.runDamageMult = 1;
    this.runMaxBonus = 0;
    this.runFeverRegenMult = 1;
    this.stamina = BALANCE.stamina.max;
    this.totonoiFullSec = 0;
    this.band = bandForTemperature(this.temperature);
    this.warningActive = false;
    this.recentPayouts = [];
  }
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}
