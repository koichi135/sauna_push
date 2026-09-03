/**
 * パーク選択（BALANCE.perks の抽選対象、Perks.ts）で積み上がる、1 ラン限りの永続倍率・加算値。
 *
 * BALANCE と違い実行時に UI から編集するものではなく、各サブシステムが
 * パーク選択のたびに Game から setter で渡された値をここに集約して保持する。
 * ラン開始時（Game.resetRun）に必ず reset() すること。
 */
export class RunModifiers {
  /** プッシャーのストローク倍率 */
  pusherStrokeMult = 1;
  /** 投入クールダウンの倍率（小さいほど速い） */
  throwCooldownMult = 1;
  /** 温度帯ダメージの倍率（サウナハットのレリックと同じ経路で乗算） */
  staminaDamageMult = 1;
  /** 最大体力への加算 */
  staminaMaxBonus = 0;
  /** 外気浴中の体力回復倍率 */
  feverRegenMult = 1;
  /** コンボ猶予への加算 (秒) */
  comboWindowBonusSec = 0;
  /** コンボ1段あたりのスコア倍率増分への加算 */
  comboScorePerStepBonus = 0;
  /** ペイアウトスコアの倍率 */
  scoreMult = 1;
  /** ペイアウトごとの手持ちストーン獲得への加算 */
  stoneGainBonus = 0;
  /** 大玉ストーンの価値への加算 */
  bigStoneValueBonus = 0;
  /** アイテム出現頻度の倍率 */
  itemSpawnRateMult = 1;
  /** ロウリュのクールダウン倍率 */
  loylyCooldownMult = 1;
  /** ロウリュの影響半径倍率 */
  loylyRadiusMult = 1;
  /** フィーバー継続時間への加算 (秒)。手動入水時のみ効く */
  feverDurationBonusSec = 0;

  reset(): void {
    this.pusherStrokeMult = 1;
    this.throwCooldownMult = 1;
    this.staminaDamageMult = 1;
    this.staminaMaxBonus = 0;
    this.feverRegenMult = 1;
    this.comboWindowBonusSec = 0;
    this.comboScorePerStepBonus = 0;
    this.scoreMult = 1;
    this.stoneGainBonus = 0;
    this.bigStoneValueBonus = 0;
    this.itemSpawnRateMult = 1;
    this.loylyCooldownMult = 1;
    this.loylyRadiusMult = 1;
    this.feverDurationBonusSec = 0;
  }
}
