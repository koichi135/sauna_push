import { BALANCE } from '../core/BalanceConfig';
import type { EventBus } from '../core/EventBus';

/**
 * 手持ちストーンの収支・スコア・コンボ（仕様 5章 / 15章3項）。
 *
 * stoneCount == 0 はゲームオーバーではない（仕様 5章）。
 * 何もできず熱に耐えるだけの STARVING 状態になり、体力が減り続ける。
 * 敗北条件は体力に一本化されている。
 *
 * スコア = ペイアウト × フィーバー倍率 × コンボ倍率 の加算 ＋ ととのいボーナス（セット数比例）。
 * コンボは「前のペイアウトから windowSec 以内に次が落ちた」で伸びる。
 * 山が崩れて一気に落ちる瞬間がそのまま高得点になる。
 */

export interface PayoutResult {
  /** 今回加算されたスコア */
  amount: number;
  /** 加算後の連鎖数 */
  combo: number;
  comboMultiplier: number;
  /** 連鎖の節目で付いた手持ちボーナス（0 なら無し） */
  bonusStones: number;
  /** 今回の加算で大玉を獲得したか */
  earnedBigStone: boolean;
}

export class Payout {
  stoneCount = BALANCE.stones.initial;
  score = 0;
  /** ととのい（手動入水によるフィーバー突入）回数 = セット数 */
  totonoiCount = 0;
  /** 累計ペイアウト数（大玉は value 個ぶん）。リザルト表示用 */
  totalPaid = 0;
  /** 現在の連鎖数。窓を過ぎると 0 に戻る */
  combo = 0;
  maxCombo = 0;
  /** 大玉ストーンの手持ち。次の投入で消費する */
  bigStoneCharges = 0;
  /** 到達した最大フィーバー倍率。リザルト表示用 */
  bestMultiplier = 1;

  private lastPayoutSec = -Infinity;
  /** 直前の節目判定に使った連鎖数。同じ節目で二重に報酬を出さない */
  private lastMilestoneCombo = 0;
  private lastBigStoneCombo = 0;

  constructor(private readonly bus: EventBus) {}

  get isStarving(): boolean {
    return this.stoneCount <= 0;
  }

  /** 現在の連鎖数に対するスコア倍率 */
  get comboMultiplier(): number {
    return comboMultiplierFor(this.combo);
  }

  /** 投入できるか。フィーバー中は手持ち消費なし（仕様 7.2） */
  canThrow(fever: boolean): boolean {
    return fever || this.stoneCount >= BALANCE.stones.costPerThrow;
  }

  /** 次の投入が大玉になるか */
  get nextThrowIsBig(): boolean {
    return this.bigStoneCharges > 0;
  }

  /**
   * 投入の消費。大玉は手持ちのチャージを 1 つ使う（通常ストーンの消費に加えて）。
   * @returns 大玉を使ったか
   */
  consumeForThrow(fever: boolean): boolean {
    const big = this.bigStoneCharges > 0;
    if (big) this.bigStoneCharges -= 1;
    if (!fever) this.stoneCount = Math.max(0, this.stoneCount - BALANCE.stones.costPerThrow);
    return big;
  }

  /**
   * ペイアウト口に落ちたときの加算。
   * @param count 落ちた個数（大玉は value 個ぶんに換算済み）
   * @param feverMultiplier フィーバー倍率
   * @param now ゲーム内経過秒。コンボ窓の判定に使う
   */
  registerPayout(count: number, feverMultiplier: number, now: number): PayoutResult {
    const c = BALANCE.combo;
    if (now - this.lastPayoutSec <= c.windowSec) {
      this.combo += count;
    } else {
      this.combo = count;
      this.lastMilestoneCombo = 0;
      this.lastBigStoneCombo = 0;
    }
    this.lastPayoutSec = now;
    if (this.combo > this.maxCombo) this.maxCombo = this.combo;

    this.stoneCount += BALANCE.stones.gainPerPayout * count;
    this.totalPaid += count;

    const comboMultiplier = this.comboMultiplier;
    const amount = Math.round(BALANCE.score.perPayout * count * feverMultiplier * comboMultiplier);
    this.score += amount;
    this.bus.emit('SCORE_ADDED', { amount, total: this.score });
    this.bus.emit('COMBO_ADVANCED', { combo: this.combo, multiplier: comboMultiplier });

    // 連鎖の節目: 手持ちボーナスと大玉
    let bonusStones = 0;
    const milestone = Math.floor(this.combo / c.milestoneEvery) * c.milestoneEvery;
    if (milestone > 0 && milestone > this.lastMilestoneCombo) {
      const steps = (milestone - this.lastMilestoneCombo) / c.milestoneEvery;
      bonusStones = c.milestoneStones * steps;
      this.stoneCount += bonusStones;
      this.lastMilestoneCombo = milestone;
    }

    let earnedBigStone = false;
    const bigMark = Math.floor(this.combo / c.bigStoneEvery) * c.bigStoneEvery;
    if (bigMark > 0 && bigMark > this.lastBigStoneCombo) {
      this.lastBigStoneCombo = bigMark;
      if (this.bigStoneCharges < c.bigStoneMaxCharges) {
        this.bigStoneCharges += 1;
        earnedBigStone = true;
        this.bus.emit('BIG_STONE_EARNED', { charges: this.bigStoneCharges });
      }
    }

    return { amount, combo: this.combo, comboMultiplier, bonusStones, earnedBigStone };
  }

  /** 固定ステップごとに呼ぶ。コンボ窓を過ぎたら連鎖を閉じる。 */
  update(now: number): void {
    if (this.combo > 0 && now - this.lastPayoutSec > BALANCE.combo.windowSec) {
      const reached = this.combo;
      this.combo = 0;
      this.lastMilestoneCombo = 0;
      this.lastBigStoneCombo = 0;
      this.bus.emit('COMBO_ENDED', { combo: reached });
    }
  }

  /** コンボ窓の残り割合 1..0（HUD 用） */
  comboWindowRatio(now: number): number {
    if (this.combo <= 0) return 0;
    const w = BALANCE.combo.windowSec;
    return Math.max(0, 1 - (now - this.lastPayoutSec) / w);
  }

  /**
   * ととのい（手動入水）。セット数を進め、セット数比例のボーナスを入れる。
   * 自動入水はここを通さない（ボーナスなし・セットに数えない）。
   */
  registerTotonoi(multiplier: number): number {
    this.totonoiCount += 1;
    if (multiplier > this.bestMultiplier) this.bestMultiplier = multiplier;
    const set = Math.min(this.totonoiCount, BALANCE.score.totonoiSetCap);
    const amount = BALANCE.score.perTotonoi * set;
    this.score += amount;
    this.bus.emit('SCORE_ADDED', { amount, total: this.score });
    this.bus.emit('SET_ADVANCED', { set: this.totonoiCount });
    return amount;
  }

  reset(): void {
    this.stoneCount = BALANCE.stones.initial;
    this.score = 0;
    this.totonoiCount = 0;
    this.totalPaid = 0;
    this.combo = 0;
    this.maxCombo = 0;
    this.bigStoneCharges = 0;
    this.bestMultiplier = 1;
    this.lastPayoutSec = -Infinity;
    this.lastMilestoneCombo = 0;
    this.lastBigStoneCombo = 0;
  }
}

/** 連鎖数 → スコア倍率。1 個目は ×1.0、以降 1 段ごとに scorePerStep ずつ伸びる */
export function comboMultiplierFor(combo: number): number {
  const c = BALANCE.combo;
  const steps = Math.max(0, Math.min(combo - 1, c.maxSteps));
  return 1 + steps * c.scorePerStep;
}

const HIGH_SCORE_KEY = 'sauna-push.highscore';

/** ハイスコアのみ localStorage に保存する（仕様 2章 禁止事項）。 */
export function loadHighScore(): number {
  try {
    const raw = localStorage.getItem(HIGH_SCORE_KEY);
    const n = raw === null ? 0 : Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    // プライベートブラウズ等で localStorage が使えない場合もゲームは成立させる
    return 0;
  }
}

export function saveHighScore(score: number): void {
  try {
    localStorage.setItem(HIGH_SCORE_KEY, String(score));
  } catch {
    // 保存できなくても続行する
  }
}
