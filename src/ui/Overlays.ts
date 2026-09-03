import { el } from './dom';

export type ScreenId = 'loading' | 'title' | 'tutorial' | 'result' | 'paused' | null;

export interface ResultData {
  score: number;
  totonoiCount: number;
  totalPaid: number;
  maxCombo: number;
  bestMultiplier: number;
  highScore: number;
  isHighScore: boolean;
  /** タイムアタックの時間切れで終えた（＝クリア）か。false は体力切れの失敗 */
  cleared: boolean;
}

export interface OverlayCallbacks {
  onStart: () => void;
  onOpenTutorial: () => void;
  onCloseTutorial: () => void;
  onRetry: () => void;
  onToTitle: () => void;
  onResume: () => void;
  onToggleMute: () => boolean;
}

/** タイトル／チュートリアル／リザルト／ポーズのオーバーレイ管理（仕様 11章）。 */
export class Overlays {
  private readonly overlay = el('overlay');
  private readonly screens: Record<Exclude<ScreenId, null>, HTMLElement> = {
    loading: el('screen-loading'),
    title: el('screen-title'),
    tutorial: el('screen-tutorial'),
    result: el('screen-result'),
    paused: el('screen-paused'),
  };
  private readonly titleHighScore = el('title-highscore');
  private readonly resultScore = el('result-score');
  private readonly resultTotonoi = el('result-totonoi');
  private readonly resultPayout = el('result-payout');
  private readonly resultCombo = el('result-combo');
  private readonly resultMult = el('result-mult');
  private readonly resultHighScore = el('result-highscore');
  private readonly resultNewRecord = el('result-newrecord');
  private readonly resultHeading = el('result-heading');
  private readonly muteBtn = el<HTMLButtonElement>('btn-mute');

  private current: ScreenId = 'loading';

  constructor(callbacks: OverlayCallbacks) {
    el<HTMLButtonElement>('btn-start').addEventListener('click', callbacks.onStart);
    el<HTMLButtonElement>('btn-tutorial').addEventListener('click', callbacks.onOpenTutorial);
    el<HTMLButtonElement>('btn-tutorial-close').addEventListener('click', callbacks.onCloseTutorial);
    el<HTMLButtonElement>('btn-retry').addEventListener('click', callbacks.onRetry);
    el<HTMLButtonElement>('btn-to-title').addEventListener('click', callbacks.onToTitle);
    el<HTMLButtonElement>('btn-resume').addEventListener('click', callbacks.onResume);
    this.muteBtn.addEventListener('click', () => {
      const muted = callbacks.onToggleMute();
      this.muteBtn.textContent = muted ? '🔇' : '🔊';
    });
  }

  show(screen: ScreenId): void {
    this.current = screen;
    if (screen === null) {
      this.overlay.hidden = true;
      return;
    }
    this.overlay.hidden = false;
    for (const [id, node] of Object.entries(this.screens)) {
      node.hidden = id !== screen;
    }
  }

  get currentScreen(): ScreenId {
    return this.current;
  }

  setHighScore(score: number): void {
    this.titleHighScore.textContent = String(score);
  }

  showResult(data: ResultData): void {
    this.resultHeading.textContent = data.cleared ? 'クリア！' : 'のぼせました';
    this.resultScore.textContent = String(data.score);
    this.resultTotonoi.textContent = String(data.totonoiCount);
    this.resultPayout.textContent = String(data.totalPaid);
    this.resultCombo.textContent = String(data.maxCombo);
    this.resultMult.textContent = `×${data.bestMultiplier.toFixed(1)}`;
    this.resultHighScore.textContent = String(data.highScore);
    this.resultNewRecord.hidden = !data.isHighScore;
    this.show('result');
  }
}
