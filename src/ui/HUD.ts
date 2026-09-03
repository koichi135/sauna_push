import { BALANCE, TEMP_BANDS } from '../core/BalanceConfig';
import type { Gauges } from '../gameplay/Gauges';
import type { Payout } from '../gameplay/Payout';
import { el } from './dom';

export interface HudState {
  gauges: Gauges;
  payout: Payout;
  fever: boolean;
  feverMultiplier: number;
  /** フィーバーの残り秒数と進捗 0..1 */
  feverRemaining: number;
  feverProgress: number;
  /** 水風呂ボタンを点灯させるか */
  coldBathReady: boolean;
  /** 点灯中に表示する「いま入水したら」の倍率と秒数 */
  pendingMultiplier: number;
  pendingDuration: number;
  /** MAX 放置から自動入水までの残り割合 1..0（未点灯なら 0） */
  autoBathRatio: number;
  /** 投入可能か（クールダウン・手持ち） */
  canThrow: boolean;
  throwReady: boolean;
  /** ロウリュモード中か */
  loylyActive: boolean;
  /** ロウリュのクールタイム進捗 0（明け）..1（直後） */
  loylyCooldownRatio: number;
  loylyCooldownSec: number;
  /** コンボ窓の残り割合 1..0 */
  comboWindowRatio: number;
  /** タイムアタックの残り秒数 */
  runRemainingSec: number;
}

/** パーク選択カードに渡す表示用データ */
export interface PerkCard {
  readonly icon: string;
  readonly label: string;
  readonly description: string;
}

export type PopupKind = 'normal' | 'combo' | 'big' | 'bonus';

/**
 * HUD（仕様 9章）。DOM オーバーレイで構成する。
 * 温度バーは帯を常時色分けし、数値だけに頼らせない（仕様 6.1）。
 */
export class HUD {
  private readonly root = el('hud');
  private readonly scoreValue = el('score-value');
  private readonly setBadge = el('set-badge');
  private readonly feverBadge = el('fever-badge');
  private readonly feverMult = el('fever-mult');
  private readonly feverTime = el('fever-time');
  private readonly feverFill = el('fever-fill');
  private readonly statusChips = el('status-chips');
  private readonly runTimerValue = el('run-timer-value');
  private readonly runTimer = el('run-timer');
  private readonly perkDraft = el('perk-draft');
  private readonly perkCards = el('perk-cards');
  private readonly tempBand = el('temp-band');
  private readonly tempValue = el('temp-value');
  private readonly tempBands = el('temp-bands');
  private readonly tempMarker = el('temp-marker');
  private readonly totonoiFill = el('totonoi-fill');
  private readonly totonoiAuto = el('totonoi-auto');
  private readonly totonoiBar: HTMLElement;
  private readonly staminaFill = el('stamina-fill');
  private readonly staminaBar: HTMLElement;
  private readonly stoneCount = el('stone-count');
  private readonly stoneCountBox: HTMLElement;
  private readonly coldBathBtn = el<HTMLButtonElement>('cold-bath-btn');
  private readonly coldBathHint = el('cold-bath-hint');
  private readonly loylyBtn = el<HTMLButtonElement>('loyly-btn');
  private readonly loylyCooldown = el('loyly-cooldown');
  private readonly throwLane = el('throw-lane');
  private readonly throwLaneMarker = el('throw-lane-marker');
  private readonly throwLaneText = el('throw-lane-text');
  private readonly bigStoneBadge = el('big-stone-badge');
  private readonly aimOverlay = el('aim-overlay');
  private readonly aimTimerFill = el('aim-timer-fill');
  private readonly combo = el('combo');
  private readonly comboCount = el('combo-count');
  private readonly comboMult = el('combo-mult');
  private readonly comboWindowFill = el('combo-window-fill');
  private readonly popupLayer = el('popup-layer');
  private readonly toastArea = el('toast-area');
  private readonly vignette = el('vignette');
  private readonly flash = el('flash');

  private displayedScore = 0;
  private lastCombo = 0;
  private readonly popups: HTMLElement[] = [];
  private static readonly MAX_POPUPS = 14;
  /** 直近のペイアウト表示。短い間隔で続く落下は 1 つの数字に積み上げる */
  private mergedPayout: { node: HTMLElement; amount: number; at: number } | null = null;
  private static readonly PAYOUT_MERGE_MS = 380;

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

  get loylyButton(): HTMLButtonElement {
    return this.loylyBtn;
  }

  /**
   * 温度帯の色分けを一度だけ作る。BALANCE の帯定義が唯一の情報源。
   * 温度計なので上が高温・下が低温になるよう、帯は逆順に積む。
   */
  private buildTempBands(): void {
    const max = BALANCE.temperature.max;
    this.tempBands.replaceChildren(
      ...[...TEMP_BANDS].reverse().map((band) => {
        const div = document.createElement('div');
        div.className = 'band';
        div.dataset.band = band.id;
        div.style.background = band.color;
        // 帯の高さは温度レンジに比例させる
        div.style.height = `${((band.max - band.min + 1) / (max + 1)) * 100}%`;
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

    // セット（ととのい回数 + 1）
    this.setBadge.textContent = `SET ${payout.totonoiCount + 1}`;

    // 温度（縦の温度計。下端が 0℃、上端が 100℃）
    const tempPct = (gauges.temperature / BALANCE.temperature.max) * 100;
    this.tempMarker.style.bottom = `${tempPct}%`;
    this.tempValue.textContent = String(Math.round(gauges.temperature));
    const band = gauges.currentBand;
    this.tempBand.textContent = band.label;
    this.tempBand.style.color = band.color;
    for (const child of this.tempBands.children) {
      child.classList.toggle('active', (child as HTMLElement).dataset.band === band.id);
    }

    // ととのい。MAX 中は自動入水までの残りを白い帯で示す
    this.totonoiFill.style.width = `${(gauges.totonoi / BALANCE.totonoi.max) * 100}%`;
    this.totonoiBar.classList.toggle('ready', gauges.isTotonoiReady);
    this.totonoiAuto.style.width = `${Math.max(0, state.autoBathRatio) * 100}%`;
    this.totonoiAuto.hidden = state.autoBathRatio <= 0;

    // 体力（パーク「頑丈な体」で最大値が伸びる）
    const staminaRatio = gauges.stamina / gauges.maxStamina;
    this.staminaFill.style.width = `${staminaRatio * 100}%`;
    const warning = staminaRatio <= BALANCE.stamina.warningRatio;
    this.staminaBar.classList.toggle('warning', warning);
    this.staminaBar.classList.toggle('shielded', gauges.relicDamageStacks > 0);

    // 手持ちストーン
    this.stoneCount.textContent = String(payout.stoneCount);
    this.stoneCountBox.classList.toggle('starving', payout.isStarving);

    // 周縁の赤み: 高温 or 低体力（仕様 10章 2 / 6.3）。冷えすぎは青
    const heatVignette = Math.max(0, (gauges.temperature - 80) / 20);
    const coldVignette = band.id === 'cold' && !state.fever ? 0.5 : 0;
    const lowStamina = warning ? 1 - staminaRatio / BALANCE.stamina.warningRatio : 0;
    this.vignette.style.opacity = String(
      Math.min(0.9, heatVignette * 0.55 + lowStamina * 0.55 + coldVignette),
    );
    this.vignette.classList.toggle('pulsing', warning);
    this.vignette.classList.toggle('cold', coldVignette > 0 && heatVignette === 0 && lowStamina === 0);

    // フィーバー倍率と残り時間
    this.feverBadge.hidden = !state.fever;
    if (state.fever) {
      this.feverMult.textContent = `×${state.feverMultiplier.toFixed(1)}`;
      this.feverTime.textContent = `${state.feverRemaining.toFixed(1)}s`;
      this.feverFill.style.width = `${Math.max(0, 1 - state.feverProgress) * 100}%`;
    }

    // 状態チップ: 永続レリックのスタック数を表示する（ローグライクのビルド確認用）
    this.updateStatusChips(gauges.relicDamageStacks);

    // タイムアタックの残り時間
    const t = Math.max(0, Math.ceil(state.runRemainingSec));
    const mm = Math.floor(t / 60);
    const ss = String(t % 60).padStart(2, '0');
    this.runTimerValue.textContent = `${mm}:${ss}`;
    this.runTimer.classList.toggle('warning', t <= 30);

    // 水風呂ボタン（点灯時のみ表示）
    this.coldBathBtn.hidden = !state.coldBathReady;
    if (state.coldBathReady) {
      this.coldBathHint.textContent = `×${state.pendingMultiplier.toFixed(1)} / ${state.pendingDuration.toFixed(1)}秒`;
      this.coldBathBtn.classList.toggle('hot', state.pendingMultiplier >= 2.0);
    }

    // ロウリュボタン: クールタイムは下から埋まる影で表す
    this.loylyBtn.classList.toggle('active', state.loylyActive);
    const cooling = state.loylyCooldownRatio > 0;
    this.loylyBtn.classList.toggle('cooling', cooling);
    this.loylyCooldown.style.height = `${state.loylyCooldownRatio * 100}%`;
    this.loylyBtn.disabled = cooling;

    // 投入レーン。ロウリュモード中は投入できない（水をかけるモードのため）
    this.throwLane.classList.toggle('cooldown', !state.throwReady);
    this.throwLane.classList.toggle('disabled', !state.canThrow || state.loylyActive);
    const big = payout.bigStoneCharges > 0;
    this.throwLane.classList.toggle('big', big);
    this.bigStoneBadge.hidden = !big;
    if (big) this.bigStoneBadge.textContent = `大玉 ×${payout.bigStoneCharges}`;
    this.throwLaneText.textContent = state.fever
      ? 'フィーバー中は投入し放題！'
      : big
        ? '次の投入は大玉ストーン'
        : 'タップしてストーン投入';

    // コンボ
    this.updateCombo(payout.combo, payout.comboMultiplier, state.comboWindowRatio);
  }

  private updateStatusChips(heatResistStacks: number): void {
    const chips: string[] = [];
    if (heatResistStacks > 0) chips.push(`🎩×${heatResistStacks}`);
    this.statusChips.replaceChildren(
      ...chips.map((text) => {
        const span = document.createElement('span');
        span.className = 'chip';
        span.textContent = text;
        return span;
      }),
    );
  }

  private updateCombo(combo: number, multiplier: number, windowRatio: number): void {
    if (combo <= 1) {
      // 1 個だけの落下はコンボとして見せない（ノイズになる）
      this.combo.hidden = true;
      this.lastCombo = combo;
      return;
    }
    this.combo.hidden = false;
    this.comboWindowFill.style.width = `${windowRatio * 100}%`;
    if (combo !== this.lastCombo) {
      this.comboCount.textContent = String(combo);
      this.comboMult.textContent = `×${multiplier.toFixed(1)}`;
      this.combo.classList.toggle('big', combo >= BALANCE.combo.bigStoneEvery);
      this.combo.classList.toggle('mid', combo >= BALANCE.combo.milestoneEvery && combo < BALANCE.combo.bigStoneEvery);
      this.combo.classList.remove('pop');
      void this.combo.offsetWidth;
      this.combo.classList.add('pop');
      this.lastCombo = combo;
    }
  }

  /** 投入位置にフィードバックを出す */
  flashThrowLane(normalizedX: number): void {
    this.throwLaneMarker.style.left = `${(normalizedX * 0.5 + 0.5) * 100}%`;
    this.throwLaneMarker.classList.remove('hit');
    // クラス再付与でアニメーションを再生し直す
    void this.throwLaneMarker.offsetWidth;
    this.throwLaneMarker.classList.add('hit');
  }

  /**
   * パーク選択画面を表示する。カードをタップすると onPick(index) を呼ぶ。
   * 呼ぶたびに前回のカードは作り直す（選択肢は毎回入れ替わるため）。
   */
  showPerkDraft(cards: readonly PerkCard[], onPick: (index: number) => void): void {
    this.perkCards.replaceChildren(
      ...cards.map((card, index) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'perk-card';
        const icon = document.createElement('div');
        icon.className = 'perk-card-icon';
        icon.textContent = card.icon;
        const label = document.createElement('div');
        label.className = 'perk-card-label';
        label.textContent = card.label;
        const desc = document.createElement('div');
        desc.className = 'perk-card-desc';
        desc.textContent = card.description;
        btn.append(icon, label, desc);
        btn.addEventListener('pointerdown', (ev) => {
          ev.preventDefault();
          onPick(index);
        });
        return btn;
      }),
    );
    this.perkDraft.hidden = false;
  }

  hidePerkDraft(): void {
    this.perkDraft.hidden = true;
    this.perkCards.replaceChildren();
  }

  /** ロウリュモードの表示。remainingRatio はモード残り時間の割合 */
  setAiming(active: boolean, remainingRatio = 1): void {
    this.aimOverlay.hidden = !active;
    if (active) this.aimTimerFill.style.width = `${Math.max(0, remainingRatio) * 100}%`;
  }

  bumpScore(): void {
    this.scoreValue.classList.remove('bump');
    void this.scoreValue.offsetWidth;
    this.scoreValue.classList.add('bump');
  }

  /**
   * 画面座標に浮かぶスコア表示。ペイアウト口の位置を 3D から投影して呼ぶ。
   * 同時表示数を抑え、古いものから消す。
   */
  popup(screenX: number, screenY: number, text: string, kind: PopupKind = 'normal'): void {
    this.spawnPopup(screenX, screenY, text, kind, 950);
  }

  /**
   * ペイアウトのスコア表示。直前の表示から PAYOUT_MERGE_MS 以内なら同じ数字に足し込む。
   * 山が崩れて連続で落ちるとき、+10 +12 +11 … と散らばるより 1 つの数字が
   * 膨らんでいくほうが「まとめて落ちた」感が出るし、重なって読めなくならない。
   */
  payoutPopup(screenX: number, screenY: number, amount: number, kind: PopupKind): void {
    const now = performance.now();
    const last = this.mergedPayout;
    if (last && now - last.at < HUD.PAYOUT_MERGE_MS && last.node.isConnected) {
      last.amount += amount;
      last.at = now;
      last.node.textContent = `+${last.amount}`;
      last.node.className = `popup popup-${kind} popup-grow`;
      last.node.style.left = `${screenX}px`;
      // アニメーションを頭から
      void last.node.offsetWidth;
      last.node.classList.remove('popup-grow');
      void last.node.offsetWidth;
      last.node.classList.add('popup-grow');
      return;
    }
    const node = this.spawnPopup(screenX, screenY, `+${amount}`, kind, 1100);
    this.mergedPayout = { node, amount, at: now };
  }

  private spawnPopup(
    screenX: number,
    screenY: number,
    text: string,
    kind: PopupKind,
    lifeMs: number,
  ): HTMLElement {
    const div = document.createElement('div');
    div.className = `popup popup-${kind}`;
    div.textContent = text;
    div.style.left = `${screenX}px`;
    div.style.top = `${screenY}px`;
    this.popupLayer.appendChild(div);
    this.popups.push(div);
    while (this.popups.length > HUD.MAX_POPUPS) this.popups.shift()?.remove();
    window.setTimeout(() => {
      div.remove();
      const i = this.popups.indexOf(div);
      if (i >= 0) this.popups.splice(i, 1);
    }, lifeMs);
    return div;
  }

  toast(text: string, kind: 'normal' | 'good' | 'bad' = 'normal'): void {
    const div = document.createElement('div');
    div.className = `toast toast-${kind}`;
    div.textContent = text;
    this.toastArea.appendChild(div);
    // 溜まりすぎると読めないので 3 つまで
    while (this.toastArea.children.length > 3) this.toastArea.firstElementChild?.remove();
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
    this.lastCombo = 0;
    this.scoreValue.textContent = '0';
    this.vignette.style.opacity = '0';
    this.vignette.classList.remove('pulsing', 'cold');
    this.feverBadge.hidden = true;
    this.coldBathBtn.hidden = true;
    this.aimOverlay.hidden = true;
    this.combo.hidden = true;
    this.bigStoneBadge.hidden = true;
    this.statusChips.replaceChildren();
    this.hidePerkDraft();
    this.toastArea.replaceChildren();
    this.popupLayer.replaceChildren();
    this.popups.length = 0;
    this.mergedPayout = null;
  }
}
