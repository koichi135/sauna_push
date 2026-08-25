import { BALANCE, TEMP_BANDS } from '../core/BalanceConfig';
import type { Gauges } from '../gameplay/Gauges';
import type { Payout } from '../gameplay/Payout';
import { el } from './dom';

export interface HudState {
  gauges: Gauges;
  payout: Payout;
  fever: boolean;
  feverMultiplier: number;
  /** 水風呂ボタンを点灯させるか */
  coldBathReady: boolean;
  /** 点灯中に表示する「いま入水したら」の倍率と秒数 */
  pendingMultiplier: number;
  pendingDuration: number;
  /** 投入可能か（クールダウン・手持ち） */
  canThrow: boolean;
  throwReady: boolean;
}

/**
 * HUD（仕様 9章）。DOM オーバーレイで構成する。
 * 温度バーは帯を常時色分けし、数値だけに頼らせない（仕様 6.1）。
 */
export class HUD {
  private readonly root = el('hud');
  private readonly scoreValue = el('score-value');
  private readonly feverBadge = el('fever-badge');
  private readonly tempBand = el('temp-band');
  private readonly tempValue = el('temp-value');
  private readonly tempBands = el('temp-bands');
  private readonly tempMarker = el('temp-marker');
  private readonly totonoiFill = el('totonoi-fill');
  private readonly totonoiBar: HTMLElement;
  private readonly staminaFill = el('stamina-fill');
  private readonly staminaBar: HTMLElement;
  private readonly stoneCount = el('stone-count');
  private readonly stoneCountBox: HTMLElement;
  private readonly coldBathBtn = el<HTMLButtonElement>('cold-bath-btn');
  private readonly coldBathHint = el('cold-bath-hint');
  private readonly throwLane = el('throw-lane');
  private readonly throwLaneMarker = el('throw-lane-marker');
  private readonly aimOverlay = el('aim-overlay');
  private readonly aimTimerFill = el('aim-timer-fill');
  private readonly toastArea = el('toast-area');
  private readonly vignette = el('vignette');
  private readonly flash = el('flash');

  private displayedScore = 0;

  constructor() {
    this.totonoiBar = this.totonoiFill.parentElement as HTMLElement;
    this.staminaBar = this.staminaFill.parentElement as HTMLElement;
    this.stoneCountBox = this.stoneCount.parentElement as HTMLElement;
    this.buildTempBands();
  }

  setVisible(visible: boolean): void {
    this.root.hidden = !visible;
  }

  get throwLaneElement(): HTMLElement {
    return this.throwLane;
  }

  get coldBathButton(): HTMLButtonElement {
    return this.coldBathBtn;
  }

  /** 温度帯の色分けを一度だけ作る。BALANCE の帯定義が唯一の情報源。 */
  private buildTempBands(): void {
    const max = BALANCE.temperature.max;
    this.tempBands.replaceChildren(
      ...TEMP_BANDS.map((band) => {
        const div = document.createElement('div');
        div.className = 'band';
        div.dataset.band = band.id;
        div.style.background = band.color;
        // 帯の幅は温度レンジに比例させる
        div.style.width = `${((band.max - band.min + 1) / (max + 1)) * 100}%`;
        return div;
      }),
    );
  }

  update(state: HudState): void {
    const { gauges, payout } = state;

    // スコアは少しずつ寄せると加算が読み取りやすい
    if (this.displayedScore !== payout.score) {
      const diff = payout.score - this.displayedScore;
      this.displayedScore += Math.abs(diff) < 3 ? diff : Math.ceil(diff * 0.34);
      this.scoreValue.textContent = String(this.displayedScore);
    }

    // 温度
    const tempPct = (gauges.temperature / BALANCE.temperature.max) * 100;
    this.tempMarker.style.left = `${tempPct}%`;
    this.tempValue.textContent = String(Math.round(gauges.temperature));
    const band = gauges.currentBand;
    this.tempBand.textContent = band.label;
    this.tempBand.style.color = band.color;
    for (const child of this.tempBands.children) {
      child.classList.toggle('active', (child as HTMLElement).dataset.band === band.id);
    }

    // ととのい
    this.totonoiFill.style.width = `${(gauges.totonoi / BALANCE.totonoi.max) * 100}%`;
    this.totonoiBar.classList.toggle('ready', gauges.isTotonoiReady);

    // 体力
    const staminaRatio = gauges.stamina / BALANCE.stamina.max;
    this.staminaFill.style.width = `${staminaRatio * 100}%`;
    const warning = staminaRatio <= BALANCE.stamina.warningRatio;
    this.staminaBar.classList.toggle('warning', warning);

    // 手持ちストーン
    this.stoneCount.textContent = String(payout.stoneCount);
    this.stoneCountBox.classList.toggle('starving', payout.isStarving);

    // 周縁の赤み: 高温 or 低体力（仕様 10章 2 / 6.3）
    const heatVignette = Math.max(0, (gauges.temperature - 80) / 20);
    const lowStamina = warning ? 1 - staminaRatio / BALANCE.stamina.warningRatio : 0;
    this.vignette.style.opacity = String(Math.min(0.9, heatVignette * 0.55 + lowStamina * 0.55));
    this.vignette.classList.toggle('pulsing', warning);

    // フィーバー倍率
    this.feverBadge.hidden = !state.fever;
    if (state.fever) this.feverBadge.textContent = `×${state.feverMultiplier.toFixed(1)}`;

    // 水風呂ボタン（点灯時のみ表示）
    this.coldBathBtn.hidden = !state.coldBathReady;
    if (state.coldBathReady) {
      this.coldBathHint.textContent = `×${state.pendingMultiplier.toFixed(1)} / ${state.pendingDuration.toFixed(1)}秒`;
    }

    // 投入レーン
    this.throwLane.classList.toggle('cooldown', !state.throwReady);
    this.throwLane.classList.toggle('disabled', !state.canThrow);
  }

  /** 投入位置にフィードバックを出す */
  flashThrowLane(normalizedX: number): void {
    this.throwLaneMarker.style.left = `${(normalizedX * 0.5 + 0.5) * 100}%`;
    this.throwLaneMarker.classList.remove('hit');
    // クラス再付与でアニメーションを再生し直す
    void this.throwLaneMarker.offsetWidth;
    this.throwLaneMarker.classList.add('hit');
  }

  setAiming(active: boolean, remainingRatio = 1): void {
    this.aimOverlay.hidden = !active;
    if (active) this.aimTimerFill.style.width = `${Math.max(0, remainingRatio) * 100}%`;
  }

  bumpScore(): void {
    this.scoreValue.classList.remove('bump');
    void this.scoreValue.offsetWidth;
    this.scoreValue.classList.add('bump');
  }

  toast(text: string): void {
    const div = document.createElement('div');
    div.className = 'toast';
    div.textContent = text;
    this.toastArea.appendChild(div);
    window.setTimeout(() => div.remove(), 1600);
  }

  /** 水風呂・ロウリュのフルスクリーンフラッシュ */
  playFlash(kind: 'water' | 'loyly'): void {
    this.flash.classList.remove('fire', 'fire-loyly');
    void this.flash.offsetWidth;
    this.flash.classList.add(kind === 'water' ? 'fire' : 'fire-loyly');
  }

  reset(): void {
    this.displayedScore = 0;
    this.scoreValue.textContent = '0';
    this.vignette.style.opacity = '0';
    this.vignette.classList.remove('pulsing');
    this.feverBadge.hidden = true;
    this.coldBathBtn.hidden = true;
    this.aimOverlay.hidden = true;
    this.toastArea.replaceChildren();
  }
}
