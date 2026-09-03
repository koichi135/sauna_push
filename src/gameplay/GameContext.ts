import type { EventBus } from '../core/EventBus';
import type { Gauges } from './Gauges';

/**
 * アイテム効果がゲームに触るための最小の窓口（仕様 8.4）。
 * ItemDef.onPayout はこれ以外の経路でゲームを触らないこと。
 * 効果の種類ごとにメソッドを分けてあるので、アイテムを足すときはここに 1 つ増やす。
 *
 * オロポとヴィヒタ以外（サウナハット・砂時計）は永続スタック型のレリック効果。
 * 「一度きりの弱いバフ」から「拾うたびにビルドが強くなる」ローグライク要素に変更した
 * （README「ゲーム性のブラッシュアップ（第3回）」参照）。
 */
export interface GameContext {
  readonly bus: EventBus;
  readonly gauges: Gauges;
  /** 体力を回復する（オロポ） */
  healStamina(amount: number): void;
  /** 一時的なスローモーション演出 */
  slowMotion(scale: number, durationSec: number): void;
  /** 盤面上の全ストーンを手前へ扇ぐ（ヴィヒタの即時効果） */
  pushAllStones(velocityZ: number, liftY: number): void;
  /** 永続: コンボ猶予を延ばす。スタックする（ヴィヒタの永続効果） */
  addPermanentComboWindow(seconds: number): void;
  /** 永続: 温度帯ダメージを乗算で軽減する。スタックする（サウナハット） */
  addPermanentDamageResist(mult: number): void;
  /** 永続: 以後の手動入水フィーバーの継続時間を延ばす。スタックする（砂時計） */
  addPermanentFeverDuration(seconds: number): void;
}
