/** 必須要素の取得。存在しなければ起動時に落とす（HTML と TS のズレを早期に検出する）。 */
export function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`要素が見つかりません: #${id}`);
  return found as T;
}
