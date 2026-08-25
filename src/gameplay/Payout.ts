import { BALANCE } from '../core/BalanceConfig';
import type { EventBus } from '../core/EventBus';

/**
 * 手持ちストーンの収支とスコア（仕様 5章 / 15章3項）。
 *
 * stoneCount == 0 はゲームオーバーではない（仕様 5章）。
 * 何もできず熱に耐えるだけの STARVING 状態になり、体力が減り続ける。
 * 敗北条件は体力に一本化されている。
 *
 * スコアの意味づけは仕様 15章3項で未決のため、暫定で
 * 「ペイアウト単純加算 × フィーバー倍率」＋「ととのい回数ボーナス」を採用し、
 * ととのい回数も別途保持して、どちらを主指標にも切り替えられるようにしてある。
 */
export class Payout {
  stoneCount = BALANCE.stones.initial;
  score = 0;
  /** ととのい（フィーバー突入）回数 */
  totonoiCount = 0;
  /** 累計ペイアウト数。リザルト表示用 */
  totalPaid = 0;

  constructor(private readonly bus: EventBus) {}

  get isStarving(): boolean {
    return this.stoneCount <= 0;
  }

  /** 投入できるか。フィーバー中は手持ち消費なし（仕様 7.2） */
  canThrow(fever: boolean): boolean {
    return fever || this.stoneCount >= BALANCE.stones.costPerThrow;
  }

  consumeForThrow(fever: boolean): void {
    if (fever) return;
    this.stoneCount = Math.max(0, this.stoneCount - BALANCE.stones.costPerThrow);
  }

  /** ペイアウト口に落ちたときの加算。倍率はフィーバー倍率。 */
  registerPayout(count: number, multiplier: number): number {
    this.stoneCount += BALANCE.stones.gainPerPayout * count;
    this.totalPaid += count;
    const amount = Math.round(BALANCE.score.perPayout * count * multiplier);
    this.score += amount;
    this.bus.emit('SCORE_ADDED', { amount, total: this.score });
    return amount;
  }

  registerTotonoi(): void {
    this.totonoiCount += 1;
    this.score += BALANCE.score.perTotonoi;
    this.bus.emit('SCORE_ADDED', { amount: BALANCE.score.perTotonoi, total: this.score });
  }

  reset(): void {
    this.stoneCount = BALANCE.stones.initial;
    this.score = 0;
    this.totonoiCount = 0;
    this.totalPaid = 0;
  }
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
