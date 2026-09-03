import type { RunModifiers } from './RunModifiers';

/**
 * パーク（ととのいのたびに 3 択から 1 つ選ぶ永続強化）。FB「単調」「考える要素が欲しい」への対応。
 *
 * アイテムのレリックと違い、こちらは**プレイヤーが能動的に選ぶ**ビルド構築の核。
 * 効果は RunModifiers を書き換えるだけで、各サブシステムはそこから値を読む
 * （Gauges.setRunModifiers 等）ので、ここに新しいパークを増やすだけで拡張できる。
 */
export interface PerkDef {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly icon: string;
  apply(mods: RunModifiers): void;
}

export const PERK_DEFS: readonly PerkDef[] = [
  {
    id: 'wide-pusher',
    label: '太い腕',
    description: 'プッシャーのストローク +15%（重ねがけ）',
    icon: '💪',
    apply: (m) => { m.pusherStrokeMult *= 1.15; },
  },
  {
    id: 'quick-hands',
    label: '早業',
    description: '投入クールダウン -15%（重ねがけ）',
    icon: '⚡',
    apply: (m) => { m.throwCooldownMult *= 0.85; },
  },
  {
    id: 'heat-ward',
    label: '火消し師',
    description: '温度帯ダメージ -20%（重ねがけ）',
    icon: '🛡️',
    apply: (m) => { m.staminaDamageMult *= 0.8; },
  },
  {
    id: 'iron-will',
    label: '頑丈な体',
    description: '最大体力 +20（即座に回復も）',
    icon: '❤️',
    apply: (m) => { m.staminaMaxBonus += 20; },
  },
  {
    id: 'combo-sense',
    label: '連鎖の才',
    description: 'コンボ猶予 +0.15秒、倍率の伸び +0.03/段',
    icon: '🔗',
    apply: (m) => { m.comboWindowBonusSec += 0.15; m.comboScorePerStepBonus += 0.03; },
  },
  {
    id: 'prospector',
    label: '山師の目',
    description: 'アイテムの出現頻度 +35%',
    icon: '👁️',
    apply: (m) => { m.itemSpawnRateMult *= 1.35; },
  },
  {
    id: 'loyly-master',
    label: 'ロウリュ達人',
    description: 'ロウリュのクールダウン -30%、範囲 +25%',
    icon: '💧',
    apply: (m) => { m.loylyCooldownMult *= 0.7; m.loylyRadiusMult *= 1.25; },
  },
  {
    id: 'onsen-body',
    label: '温泉権化',
    description: '外気浴中の体力回復 +50%',
    icon: '♨️',
    apply: (m) => { m.feverRegenMult *= 1.5; },
  },
  {
    id: 'lucky-star',
    label: 'ご褒美体質',
    description: 'ペイアウトスコア +10%（重ねがけ）',
    icon: '⭐',
    apply: (m) => { m.scoreMult *= 1.1; },
  },
  {
    id: 'stone-blessing',
    label: '石の恵み',
    description: 'ペイアウトごとの手持ち獲得 +1',
    icon: '🪨',
    apply: (m) => { m.stoneGainBonus += 1; },
  },
  {
    id: 'big-stone-smith',
    label: '大玉職人',
    description: '大玉ストーンの価値 +2個',
    icon: '⛰️',
    apply: (m) => { m.bigStoneValueBonus += 2; },
  },
  {
    id: 'long-soak',
    label: '長湯',
    description: '外気浴の継続時間 +2秒（手動入水時）',
    icon: '⏳',
    apply: (m) => { m.feverDurationBonusSec += 2; },
  },
];

/** 重複無しで n 個を無作為抽出する */
export function draftPerks(n: number): PerkDef[] {
  const pool = [...PERK_DEFS];
  const picked: PerkDef[] = [];
  for (let i = 0; i < n && pool.length > 0; i += 1) {
    const idx = Math.floor(Math.random() * pool.length);
    picked.push(pool[idx] as PerkDef);
    pool.splice(idx, 1);
  }
  return picked;
}
