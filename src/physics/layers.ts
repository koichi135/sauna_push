/**
 * 衝突レイヤー（仕様 3章）。
 * Rapier の collision group は上位16bit = membership, 下位16bit = filter。
 */
export const LAYER = {
  STONE: 0x0001,
  ITEM: 0x0002,
  PUSHER: 0x0004,
  WALL: 0x0008,
  SENSOR_PAYOUT: 0x0010,
  SENSOR_LOST: 0x0020,
} as const;

export type LayerName = keyof typeof LAYER;

export function group(membership: number, filter: number): number {
  return ((membership & 0xffff) << 16) | (filter & 0xffff);
}

const SOLID = LAYER.STONE | LAYER.ITEM | LAYER.PUSHER | LAYER.WALL;

/** ストーン・アイテムは全ての固体とセンサーに反応する */
export const GROUP_STONE = group(LAYER.STONE, SOLID | LAYER.SENSOR_PAYOUT | LAYER.SENSOR_LOST);
export const GROUP_ITEM = group(LAYER.ITEM, SOLID | LAYER.SENSOR_PAYOUT | LAYER.SENSOR_LOST);
/** プッシャーと壁は固体のみ。センサーとは干渉させない */
export const GROUP_PUSHER = group(LAYER.PUSHER, SOLID);
export const GROUP_WALL = group(LAYER.WALL, SOLID);
/** センサーはストーンとアイテムだけを拾う */
export const GROUP_SENSOR_PAYOUT = group(LAYER.SENSOR_PAYOUT, LAYER.STONE | LAYER.ITEM);
export const GROUP_SENSOR_LOST = group(LAYER.SENSOR_LOST, LAYER.STONE | LAYER.ITEM);
