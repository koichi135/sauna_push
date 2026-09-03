import { BALANCE } from '../core/BalanceConfig';
import type { PhysicsWorld, TrackedBody } from '../physics/PhysicsWorld';
import type { GameContext } from './GameContext';

/**
 * アイテム（仕様 8章）。
 * 盤面上にストーンに混じって存在し、**ペイアウト口に落ちた時のみ**発動する。
 * ロスト溝に落ちた場合は消滅のみで効果なし。
 */

/**
 * 仕様 8章のオロポに加え、8.3 の追加案（ヴィヒタ／サウナハット／砂時計）を採用した。
 * ロウリュは常設ボタン＋クールタイム制に変わったため、盤面アイテムからは外した。
 */
export type ItemId = 'oropo' | 'vihta' | 'hat' | 'hourglass';

export interface ItemDef {
  readonly id: ItemId;
  /** 抽選重み */
  readonly weight: number;
  readonly modelKey: string;
  readonly label: string;
  /** HUD／3D で使う色 */
  readonly color: number;
  onPayout(ctx: GameContext): void;
  /** 取得後にプレイヤーの照準入力を待つか */
  readonly requiresAiming: boolean;
}

export const ITEM_DEFS: readonly ItemDef[] = [
  {
    id: 'oropo',
    weight: 3,
    modelKey: 'can',
    label: 'オロポ',
    color: 0xffe14d,
    requiresAiming: false,
    onPayout(ctx) {
      ctx.healStamina(BALANCE.items.oropo.staminaGain);
      ctx.slowMotion(BALANCE.items.oropo.slowMoScale, BALANCE.items.oropo.slowMoSec);
      ctx.bus.emit('OROPO_DRUNK', { staminaGain: BALANCE.items.oropo.staminaGain });
    },
  },
  {
    // 白樺の葉束。盤面のストーンをまとめて手前へ扇ぐ＝山崩し。大量ペイアウトとコンボの種
    id: 'vihta',
    weight: 3,
    modelKey: 'vihta',
    label: 'ヴィヒタ',
    color: 0x6cc24a,
    requiresAiming: false,
    onPayout(ctx) {
      ctx.pushAllStones(BALANCE.items.vihta.pushVelocity, BALANCE.items.vihta.liftVelocity);
    },
  },
  {
    // 耐熱。灼熱帯に踏み込んで最大倍率を狙う時間を買える
    id: 'hat',
    weight: 2,
    modelKey: 'hat',
    label: 'サウナハット',
    color: 0xd9c9a8,
    requiresAiming: false,
    onPayout(ctx) {
      ctx.addHeatShield(BALANCE.items.hat.shieldSec);
    },
  },
  {
    // フィーバー中なら延長、それ以外はととのいを即加算
    id: 'hourglass',
    weight: 2,
    modelKey: 'hourglass',
    label: '砂時計',
    color: 0xb48cff,
    requiresAiming: false,
    onPayout(ctx) {
      ctx.extendFeverOrTotonoi(
        BALANCE.items.hourglass.feverExtendSec,
        BALANCE.items.hourglass.totonoiGain,
      );
    },
  },
];

export function itemDef(id: ItemId): ItemDef {
  const def = ITEM_DEFS.find((d) => d.id === id);
  if (!def) throw new Error(`未知のアイテム: ${id}`);
  return def;
}

export class ItemSystem {
  /** 盤面上に存在するアイテムの TrackedBody */
  private onBoard = new Set<number>();
  private sinceLastSpawnSec = 0;
  private payoutsSinceLastSpawn = 0;

  constructor(private readonly physics: PhysicsWorld) {}

  get onBoardCount(): number {
    return this.onBoard.size;
  }

  /** ペイアウトのたびに呼ぶ。出現条件のカウンタを進める。 */
  registerPayout(count: number): void {
    this.payoutsSinceLastSpawn += count;
  }

  /**
   * 出現判定（仕様 8章）。
   * 45秒経過、または30秒経過かつペイアウト20回で盤面奥に投下する。
   */
  update(dt: number): ItemId | null {
    this.sinceLastSpawnSec += dt;
    if (this.onBoard.size >= BALANCE.items.maxOnBoard) return null;

    const byTime = this.sinceLastSpawnSec >= BALANCE.items.intervalSec;
    const byPayout =
      this.sinceLastSpawnSec >= BALANCE.items.minIntervalSec &&
      this.payoutsSinceLastSpawn >= BALANCE.items.payoutThreshold;
    if (!byTime && !byPayout) return null;

    this.sinceLastSpawnSec = 0;
    this.payoutsSinceLastSpawn = 0;
    return this.spawn();
  }

  private spawn(): ItemId {
    const def = pickWeighted(ITEM_DEFS);
    // 投入口と同じ奥から、左右にばらして落とす
    const x = (Math.random() - 0.5) * 2 * BALANCE.spawn.maxAbsX * 0.8;
    const tracked = this.physics.spawnItem(def.id, x, BALANCE.spawn.y + 0.04, BALANCE.spawn.z);
    this.onBoard.add(tracked.id);
    return def.id;
  }

  /** ペイアウトまたはロストで盤面から消えたとき */
  notifyRemoved(tracked: TrackedBody): void {
    this.onBoard.delete(tracked.id);
  }

  reset(): void {
    this.onBoard.clear();
    this.sinceLastSpawnSec = 0;
    this.payoutsSinceLastSpawn = 0;
  }
}

function pickWeighted(defs: readonly ItemDef[]): ItemDef {
  let total = 0;
  for (const d of defs) total += d.weight;
  let r = Math.random() * total;
  for (const d of defs) {
    r -= d.weight;
    if (r <= 0) return d;
  }
  return defs[defs.length - 1] as ItemDef;
}
