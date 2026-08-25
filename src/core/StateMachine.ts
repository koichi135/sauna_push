/**
 * 仕様 11章の状態機械。
 *
 *   BOOT → TITLE → TUTORIAL(初回のみ) → PLAYING
 *   PLAYING ⇄ AIMING(ロウリュ照準)
 *   PLAYING → COLD_BATH → FEVER → PLAYING
 *   PLAYING → GAME_OVER → RESULT → TITLE
 *   任意 → PAUSED (visibilitychange)
 */
export type GameState =
  | 'BOOT'
  | 'TITLE'
  | 'TUTORIAL'
  | 'PLAYING'
  | 'AIMING'
  | 'COLD_BATH'
  | 'FEVER'
  | 'GAME_OVER'
  | 'RESULT'
  | 'PAUSED';

const TRANSITIONS: Record<GameState, readonly GameState[]> = {
  BOOT: ['TITLE'],
  TITLE: ['TUTORIAL', 'PLAYING'],
  TUTORIAL: ['PLAYING'],
  PLAYING: ['AIMING', 'COLD_BATH', 'FEVER', 'GAME_OVER'],
  // フィーバー中にロウリュを取ることがあるため、AIMING は双方向に繋ぐ。
  // どちらへ戻すかは Game が照準開始時の状態を覚えている。
  AIMING: ['PLAYING', 'FEVER', 'GAME_OVER'],
  COLD_BATH: ['FEVER'],
  FEVER: ['PLAYING', 'AIMING', 'GAME_OVER'],
  GAME_OVER: ['RESULT'],
  RESULT: ['TITLE'],
  // PAUSED からの復帰先は resume() が保存済みの状態へ戻すため、ここでは列挙しない
  PAUSED: [],
};

/** 物理は進めるが入力を遮断する状態（仕様 11章） */
const INPUT_BLOCKED: ReadonlySet<GameState> = new Set<GameState>(['COLD_BATH', 'GAME_OVER', 'PAUSED', 'RESULT']);

/** ゲームプレイのゲージが進行する状態 */
const GAUGES_RUNNING: ReadonlySet<GameState> = new Set<GameState>(['PLAYING', 'AIMING', 'FEVER']);

export class StateMachine {
  private current: GameState = 'BOOT';
  /** PAUSED に入る直前の状態。復帰時にここへ戻す */
  private pausedFrom: GameState | null = null;
  private readonly listeners = new Set<(to: GameState, from: GameState) => void>();

  get state(): GameState {
    return this.current;
  }

  get isPaused(): boolean {
    return this.current === 'PAUSED';
  }

  get inputBlocked(): boolean {
    return INPUT_BLOCKED.has(this.current);
  }

  get gaugesRunning(): boolean {
    return GAUGES_RUNNING.has(this.current);
  }

  onChange(listener: (to: GameState, from: GameState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  can(to: GameState): boolean {
    return TRANSITIONS[this.current].includes(to);
  }

  /** 遷移する。許可されていない遷移は false を返し、状態を変えない。 */
  transition(to: GameState): boolean {
    if (this.current === to) return false;
    if (!this.can(to)) {
      console.warn(`[StateMachine] 不正な遷移: ${this.current} → ${to}`);
      return false;
    }
    this.set(to);
    return true;
  }

  /** ブラウザの visibilitychange から呼ばれる。PAUSED 中や TITLE 系では何もしない。 */
  pause(): boolean {
    if (this.current === 'PAUSED') return false;
    if (!GAUGES_RUNNING.has(this.current) && this.current !== 'COLD_BATH') return false;
    this.pausedFrom = this.current;
    this.set('PAUSED');
    return true;
  }

  resume(): boolean {
    if (this.current !== 'PAUSED' || this.pausedFrom === null) return false;
    const to = this.pausedFrom;
    this.pausedFrom = null;
    this.set(to);
    return true;
  }

  private set(to: GameState): void {
    const from = this.current;
    this.current = to;
    for (const listener of [...this.listeners]) listener(to, from);
  }
}
