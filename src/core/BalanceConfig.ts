/**
 * 仕様書中の全数値をここに集約する（仕様 12章）。
 * ゲームロジックは必ずこのオブジェクト経由で数値を読むこと。直値の埋め込みは禁止。
 * `?debug=1` の DebugPanel がこのオブジェクトを実行時に書き換えるため、
 * モジュール読み込み時に値をコピーして保持してはならない（毎回 BALANCE.x を読む）。
 */

/** 温度帯の定義（仕様 6.1 帯域テーブル）。min は含む、max は含む。 */
export interface TempBand {
  readonly id: 'cold' | 'lukewarm' | 'optimal' | 'hot' | 'scorching';
  /** HUD 表示名 */
  readonly label: string;
  readonly min: number;
  readonly max: number;
  /** ととのい獲得倍率 */
  readonly totonoiMultiplier: number;
  /** 体力の毎秒変化（負値がダメージ） */
  readonly staminaPerSec: number;
  /** HUD の温度バーで使う色 */
  readonly color: string;
}

export const TEMP_BANDS: readonly TempBand[] = [
  { id: 'cold', label: '冷え', min: 0, max: 39, totonoiMultiplier: 0.1, staminaPerSec: 0, color: '#4a90d9' },
  { id: 'lukewarm', label: 'ぬるい', min: 40, max: 59, totonoiMultiplier: 0.5, staminaPerSec: 0, color: '#5bbfa5' },
  { id: 'optimal', label: '適温', min: 60, max: 84, totonoiMultiplier: 1.0, staminaPerSec: 0, color: '#6dc65b' },
  { id: 'hot', label: '熱い', min: 85, max: 94, totonoiMultiplier: 1.4, staminaPerSec: -2.0, color: '#e8a33d' },
  { id: 'scorching', label: '灼熱', min: 95, max: 100, totonoiMultiplier: 0.6, staminaPerSec: -6.0, color: '#e0483a' },
];

export function bandForTemperature(temperature: number): TempBand {
  for (const band of TEMP_BANDS) {
    if (temperature <= band.max) return band;
  }
  // temperature > 100 は灼熱に丸める。TEMP_BANDS は空にしないこと。
  return TEMP_BANDS[TEMP_BANDS.length - 1] as TempBand;
}

export const BALANCE = {
  /** 座標系・寸法（仕様 3章）。1 unit = 1 meter, Y-up, プレイヤーは -Z 側から +Z を見る。 */
  field: {
    /** フィールド幅 X: [-halfWidth, +halfWidth] */
    halfWidth: 0.3,
    /** 手前のペイアウト境界。この Z より手前に落ちたら獲得 */
    payoutZ: -0.25,
    /** 盤面の奥端 */
    backZ: 0.25,
    /**
     * プッシャー上段（＝ストーンが最初に乗る面）の高さ。仕様 3章の「Y=0」。
     * 仕様表では下段テーブルも Y=0（同一平面）と書かれているが、同一平面ではプッシャーが
     * 山を押し出せず遊びが成立しないため、下段のみ lowerTableY へ下げている。
     * この段差が「押し出して落とす」というコインプッシャーの中核なので、
     * 高さを 0 に戻す変更はしないこと。
     */
    shelfTopY: 0,
    /** 下段テーブル面。shelfTopY との差が段差になる */
    lowerTableY: -0.035,
    /** 落下判定を行う高さ。これより下に落ちたストーンはセンサーで処理される */
    killPlaneY: -0.25,
    /**
     * 側面レールがある奥側の範囲。これより手前は左右が開いていてロスト溝へ落ちる。
     * プッシャーが掃く帯より少しだけ手前に置き、「山ができる区間だけ横が開いている」
     * 状態を作る。ここを奥へ動かすと横ロストが起きなくなり、緊張感が消える。
     */
    railFrontZ: -0.1,
    /** レールの奥端 */
    railBackZ: 0.36,
    /** レールの高さ（下段テーブル面からの高さ）。シュートの高さより上まで要る */
    railTopY: 0.14,
    /** 盤面の壁の高さ */
    wallHeight: 0.09,
    /** 奥の固定壁の Z。シュート上端より更に奥に置く */
    backWallZ: 0.36,

    /**
     * 投入シュート（固定）。投入口 (spawn.z) で受けたストーンを前へ滑らせ、
     * プッシャー板の手前寄りに落とす。
     *
     * これは見た目のための飾りではなく、コインプッシャーが成立するための要。
     * 板の上に直接ストーンを落とすと、ストーンは摩擦で板と一緒に往復するだけで
     * 前縁に到達せず、永久に落ちない。シュートで板の前縁近くへ配給し、
     * かつシュート前縁が「フード」として後退する板からストーンを掻き落とすことで、
     * はじめて山が前へ送られる。撤去・平坦化しないこと。
     */
    chute: {
      /** 前端（低い側）。板の上面 shelfTopY との隙間はストーン厚 0.016 未満にすること */
      frontZ: 0.06,
      frontY: 0.012,
      /** 奥端（高い側）。投入口より奥まで伸ばす */
      backZ: 0.34,
      backY: 0.122,
      thickness: 0.02,
      /** 滑走面なので摩擦は低く。ストーンが途中で止まると配給が詰まる */
      friction: 0.08,
    },
  },

  /** 物理パラメータ（仕様 3章） */
  physics: {
    gravity: -18.0,
    fixedTimeStep: 1 / 60,
    maxSubStepsPerFrame: 3,
    stone: {
      radius: 0.03,
      /** 厚み。コライダーの halfHeight は thickness/2 */
      thickness: 0.016,
      friction: 0.35,
      restitution: 0.03,
      linearDamping: 0.15,
      angularDamping: 0.4,
      density: 900,
    },
    item: {
      radius: 0.038,
      thickness: 0.02,
      friction: 0.4,
      restitution: 0.05,
      linearDamping: 0.15,
      angularDamping: 0.4,
      density: 700,
    },
    /** アクティブ剛体の上限（仕様 3章 性能予算）。超過時は最も奥のスリープ中ストーンから消す */
    maxActiveBodies: 120,
    /** 衝突音を鳴らす速度変化のしきい値 (m/s) */
    impactSpeedThreshold: 0.35,
  },

  /** プッシャー（仕様 4章） */
  pusher: {
    stroke: 0.12,
    period: 2.4,
    /** フィーバー中の周期（倍速） */
    feverPeriod: 1.2,
    /**
     * 押し板の奥行き。後端が常にシュート下（＝フードの内側）に隠れる長さが要る。
     * 短くすると後退時に板の後ろへ隙間が開き、ストーンがそこへ落ちて詰まる。
     */
    depth: 0.3,
    /**
     * 押し板の厚み（上面 shelfTopY から下方向へ）。
     * 下段テーブル面 (lowerTableY = -0.035) より上で止めること。
     * 厚くして下段に潜り込ませると、静的な板を押しのけようとして挙動が壊れる。
     */
    height: 0.03,
    /**
     * 往復の基準位置（板の中心 Z、最前進時）。
     * z = baseZ + stroke * 0.5 * (1 - cos(2πt/period)) で baseZ..baseZ+stroke を動く。
     *
     * depth と合わせて、板の前面が最前進時に payoutZ の 0.12 ほど手前
     * （＝山ができる区間を 2〜4 個ぶん残す位置）で止まるよう決めてある。
     * 奥へずらすと前面が山に届かず落ちなくなり、手前へ出しすぎると
     * 山ができる前に落ちてしまって「積んで崩す」面白さが消える。
     */
    baseZ: 0.02,
  },

  /** ストーン投入（仕様 5章） */
  spawn: {
    z: 0.24,
    y: 0.1,
    /** 連射クールダウン (ms) */
    cooldownMs: 200,
    /** フィーバー中のクールダウン (ms) */
    feverCooldownMs: 80,
    /** 投入位置の X 方向の可動範囲（フィールド幅より少し内側） */
    maxAbsX: 0.26,
    /** 投入時に与える初速（わずかに奥から手前へ） */
    initialVelocityZ: -0.15,
  },

  /** 手持ちストーンの収支（仕様 5章） */
  stones: {
    initial: 30,
    costPerThrow: 1,
    gainPerPayout: 2,
  },

  /** 温度（仕様 6.1） */
  temperature: {
    initial: 55,
    min: 0,
    max: 100,
    /** 自然放熱 (per sec) */
    coolPerSec: -1.6,
    /** ストーン1個のペイアウトによる上昇 */
    gainPerPayout: 1.5,
    /** 水風呂直後の温度 */
    afterColdBath: 5,
  },

  /** ととのい（仕様 6.2） */
  totonoi: {
    initial: 0,
    max: 100,
    /** 基礎獲得量 (per sec)。温度帯倍率が掛かる */
    basePerSec: 8.0,
    /** 直近1秒のペイアウト数に対する加算係数 (per sec) */
    payoutBonusPerSec: 1.2,
    /** ペイアウト数を数える窓 (sec) */
    payoutWindowSec: 1.0,
    /** MAX 放置から自動で水風呂へ移行するまでの秒数 */
    autoColdBathSec: 8.0,
  },

  /** 体力（仕様 6.3） */
  stamina: {
    initial: 100,
    max: 100,
    /** stoneCount == 0 のときの追加ダメージ (per sec) */
    starvingPerSec: -2.0,
    /** この割合以下で警告演出（周縁の赤明滅＋心拍SE） */
    warningRatio: 0.25,
  },

  /** 水風呂・フィーバー（仕様 7章、案A） */
  fever: {
    /** 入水演出の長さ (sec)。この間は入力停止＋プッシャー停止 */
    coldBathSec: 1.5,
    /** 倍率 = clamp(1 + (temp - refTemp) / tempSpan * multiplierGain, min, max) */
    refTemp: 60,
    tempSpan: 40,
    multiplierGain: 2.0,
    multiplierMin: 1.0,
    multiplierMax: 3.0,
    /** 継続時間 = baseSec + (temp - refTemp) / tempSpan * durationGain, clamp[min,max] */
    baseDurationSec: 8.0,
    durationGain: 6.0,
    durationMin: 8.0,
    durationMax: 14.0,
    /** MAX 放置による自動移行時の倍率（ボーナスなし） */
    autoMultiplier: 1.0,
  },

  /** アイテム（仕様 8章） */
  items: {
    /** 前回出現からこの秒数が経てば無条件で出現 */
    intervalSec: 45,
    /** 前回出現から minIntervalSec 経過 かつ payoutThreshold 回ペイアウトで出現 */
    minIntervalSec: 30,
    payoutThreshold: 20,
    /** 盤面上の同時存在数 */
    maxOnBoard: 3,
    loyly: {
      /** 着弾点の影響半径 */
      radius: 0.12,
      /** 基礎温度上昇 */
      baseTemp: 25.0,
      /** 半径内のストーン1個あたりの加算 */
      perStoneTemp: 1.5,
      /** 加算に使うストーン数の上限（=> 最大 +40） */
      maxStones: 10,
      /** 照準の制限時間 (sec)。超過で中央に自動着弾 */
      aimTimeoutSec: 5.0,
    },
    oropo: {
      staminaGain: 35,
      /** スローモーションの長さ (sec) と時間スケール */
      slowMoSec: 0.3,
      slowMoScale: 0.35,
    },
  },

  /** スコア。仕様 15章 3項が未決のため暫定（単純加算＋フィーバー倍率） */
  score: {
    perPayout: 10,
    /** ととのい1回（フィーバー突入）ごとのボーナス */
    perTotonoi: 250,
  },

  /** 演出・性能（仕様 10章 / 3章 品質オートスケール） */
  view: {
    /** カメラの俯角（度） */
    cameraPitchDeg: 45,
    /**
     * 縦持ちの狭い横画角で幅 0.60 の盤面が収まる距離。
     * 近づけると盤面の左右が切れてロスト溝が見えなくなる。
     */
    cameraDistance: 1.5,
    cameraFov: 46,
    /** この fps を下回る状態が degradeAfterSec 続いたら品質を1段落とす */
    fpsFloor: 30,
    degradeAfterSec: 2.0,
    /** 品質段階 0 が最高。段階ごとのパーティクル密度倍率 */
    qualitySteps: [1.0, 0.6, 0.3, 0.12],
    steam: {
      /** 最高品質でのパーティクル数 */
      maxParticles: 220,
      /** 温度 0..100 を density 0..1 に写す下限温度 */
      minTemp: 30,
    },
  },

  /** 音（仕様 10章） */
  audio: {
    /** 衝突音の同時発音数上限 */
    maxImpactVoices: 8,
    /** 衝突音のピッチランダム化幅（±割合） */
    impactPitchJitter: 0.25,
    masterVolume: 0.7,
  },

  /** 入力（仕様 9章） */
  input: {
    /** HUD 要素の下に設ける不感帯 (px) */
    deadZonePx: 8,
  },
};

export type Balance = typeof BALANCE;
