/** ゲーム内イベントのペイロード定義。ここに無いイベントは発火できない。 */
export interface GameEvents {
  /** ストーンが投入された */
  STONE_THROWN: { x: number };
  /** ストーンがペイアウト口に落ちた */
  STONE_PAID: { x: number; z: number; count: number };
  /** ストーンが左右のロスト溝に落ちた */
  STONE_LOST: { x: number; z: number };
  /** 剛体数の上限超過でストーンが間引かれた（スコア補填なし） */
  STONE_CULLED: { count: number };
  /** ストーン同士・盤面との衝突（音用）。speed は衝突時の相対速度 */
  STONE_IMPACT: { x: number; y: number; z: number; speed: number };
  /** アイテムが盤面に出現した */
  ITEM_SPAWNED: { id: string };
  /** アイテムがペイアウト口に落ちて発動した */
  ITEM_COLLECTED: { id: string };
  /** ロウリュが着弾した */
  LOYLY_FIRED: { x: number; z: number; stones: number; deltaTemp: number };
  /** オロポを取得した */
  OROPO_DRUNK: { staminaGain: number };
  /** 温度帯が変わった */
  BAND_CHANGED: { from: string; to: string };
  /** ととのいが MAX に達し、水風呂ボタンが点灯した */
  TOTONOI_READY: Record<string, never>;
  /** 入水した。multiplier / duration は入水時の温度から決まる */
  COLD_BATH_ENTERED: { temperature: number; multiplier: number; duration: number; auto: boolean };
  /** 外気浴（フィーバー）開始 */
  FEVER_STARTED: { multiplier: number; duration: number };
  /** 外気浴終了 */
  FEVER_ENDED: Record<string, never>;
  /** スコア加算 */
  SCORE_ADDED: { amount: number; total: number };
  /** 連続ペイアウトが伸びた */
  COMBO_ADVANCED: { combo: number; multiplier: number };
  /** 連鎖が途切れた。combo は到達した連鎖数 */
  COMBO_ENDED: { combo: number };
  /** 大玉ストーンを獲得した */
  BIG_STONE_EARNED: { charges: number };
  /** 大玉ストーンがペイアウトした */
  BIG_STONE_PAID: { x: number; z: number };
  /** ととのい（セット）数が進んだ。難度スケールが更新される */
  SET_ADVANCED: { set: number };
  /** 体力が警告域に入った／出た */
  STAMINA_WARNING: { active: boolean };
  /** ゲームオーバー */
  GAME_OVER: { score: number; totonoiCount: number; isHighScore: boolean };
  /** 品質段階が変わった */
  QUALITY_CHANGED: { step: number };
}

export type GameEventName = keyof GameEvents;
type Handler<K extends GameEventName> = (payload: GameEvents[K]) => void;

/**
 * 型付きの最小イベントバス。
 * 発火中にハンドラが購読解除しても安全なよう、リスナ配列のコピーに対して呼び出す。
 */
export class EventBus {
  private readonly handlers = new Map<GameEventName, Set<Handler<GameEventName>>>();

  on<K extends GameEventName>(name: K, handler: Handler<K>): () => void {
    let set = this.handlers.get(name);
    if (!set) {
      set = new Set();
      this.handlers.set(name, set);
    }
    set.add(handler as Handler<GameEventName>);
    return () => {
      set.delete(handler as Handler<GameEventName>);
    };
  }

  emit<K extends GameEventName>(name: K, payload: GameEvents[K]): void {
    const set = this.handlers.get(name);
    if (!set || set.size === 0) return;
    for (const handler of [...set]) {
      (handler as Handler<K>)(payload);
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}
