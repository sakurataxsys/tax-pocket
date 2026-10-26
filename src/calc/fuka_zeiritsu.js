// 所得税に上乗せする復興特別所得税・防衛特別所得税の率を、income_tax_rates.json の版から取り出す。
//
// 根拠条文（原文と出典URLは data/income_tax_rates.json）
//   復興財確法 13条・28条2項        復興特別所得税（令和8年分まで2.1%・令和9年分から1.1%）
//   防衛財源確保法 5条の9・5条の26  防衛特別所得税（令和9年分から1%）
//
// ★率を使う画面（退職金・報酬の源泉徴収・ふるさと納税・所得税エンジン）は、すべてここを通す。
//   合計（2.1%）だけを持つと、令和9年分以後の内訳（防衛1%＋復興1.1%）が画面に出せず、
//   復興だけを読むと防衛の1%を黙って落とす。
//
// ★Number() を通してから Number.isFinite で見る（判断ログ D-41）。
//   JSON の値が文字列 "1.1" でも数として通す。数にならない値・欠けたキーは null を返し、
//   呼び出し側は計算を止める。**黙って0にしない**（防衛の1%を落とした過少額が、正しい顔で出るため）。

/**
 * 版から率を取り出す。
 *
 * 戻り値：{ fukko, boei, gokei }（いずれもパーセント）。取り出せなければ null。
 *
 * 『付加税率パーセント』が無く旧キー『復興特別所得税率パーセント』だけがある版は、
 * 防衛0として読む。これは**古い data を読んだ新しい画面**の経路で、古い data は
 * 平成27年分以降の単一の版（2.1%）なので、令和9年分でも合計2.1%＝金額は正しい（判断ログ D-45）。
 */
export function fuka_zeiritsu(rate_version) {
  if (rate_version === null || rate_version === undefined) return null;
  const ireko = rate_version["付加税率パーセント"];
  if (ireko === null || (ireko !== undefined && typeof ireko !== "object")) return null;

  const fukko = to_ritsu(
    ireko === undefined ? rate_version["復興特別所得税率パーセント"] : ireko["復興特別所得税"],
  );
  const boei = ireko === undefined ? 0 : to_ritsu(ireko["防衛特別所得税"]);
  if (fukko === null || boei === null) return null;
  return { fukko, boei, gokei: fukko + boei };
}

/**
 * 率を数にする。★Number(null) と Number("") は 0 になるので、先に弾く（欠けた値を0に化けさせない）。
 * Number(undefined) は NaN なので isFinite で落ちる。
 */
function to_ritsu(raw) {
  if (raw === null || raw === "") return null;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : null;
}

/**
 * 税目の呼び名。防衛特別所得税がある年分は3つを並べる
 * （並びは防衛財源確保法5条の27「所得税、防衛特別所得税及び復興特別所得税」に合わせる）。
 */
export function fuka_meisho(fz) {
  return fz.boei > 0
    ? "所得税、防衛特別所得税及び復興特別所得税"
    : "所得税及び復興特別所得税";
}

/** 合計の乗率を「102.1%」の形の数で返す（浮動小数の誤差を小数第2位で丸める） */
export function fuka_joritsu_percent(fz) {
  return Math.round((100 + fz.gokei) * 100) / 100;
}
