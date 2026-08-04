// 表示のための整形。計算はここでしない。

/** 1234567 → "1,234,567" */
export function format_number(n) {
  return Number(n).toLocaleString("ja-JP");
}

/** 1234567 → "1,234,567円" */
export function format_en(n) {
  return `${format_number(n)}円`;
}

/**
 * 償却率などの率を、表に載っている桁数のまま表示する。
 * 0.4 → "0.400"。桁を落とすと表と見比べたときに別物に見えるため。
 */
export function format_ritsu(n, keta) {
  return Number(n).toFixed(keta);
}

/** 入力欄の文字列から数値を取り出す（全角数字・カンマ・空白を許す） */
export function parse_number(text) {
  const hankaku = String(text ?? "")
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[^0-9]/g, "");
  return hankaku === "" ? 0 : Number(hankaku);
}

/**
 * 西暦 → 和暦の年分表示。令和は2019年から。
 * 収録年分は令和に限るため、令和より前は西暦のまま返す。
 */
export function format_nenbun(seireki) {
  if (seireki >= 2019) {
    const n = seireki - 2018;
    return n === 1 ? "令和元年分" : `令和${n}年分`;
  }
  return `${seireki}年分`;
}

/**
 * 西暦 → 「2026年（令和8年）」形式。取得年の選択欄などに使う。
 * 2019年は4月30日までが平成31年、5月1日からが令和元年なので両方を出す。
 */
export function format_nen(seireki) {
  if (seireki === 2019) return "2019年（平成31年・令和元年）";
  if (seireki > 2019) return `${seireki}年（令和${seireki - 2018}年）`;
  if (seireki >= 1989) {
    const n = seireki - 1988;
    return `${seireki}年（平成${n === 1 ? "元" : n}年）`;
  }
  return `${seireki}年`;
}

/**
 * 年月日 → 和暦の年（「令和8年」）。改元日をまたぐ年は日付で分ける。
 * 令和は2019年5月1日から、平成は1989年1月8日から。
 */
function wareki_nen(y, m, d) {
  const md = m * 100 + d;
  if (y > 2019 || (y === 2019 && md >= 501)) {
    const n = y - 2018;
    return `令和${n === 1 ? "元" : n}年`;
  }
  if (y > 1989 || (y === 1989 && md >= 108)) {
    const n = y - 1988;
    return `平成${n === 1 ? "元" : n}年`;
  }
  return `${y}年`; // 昭和以前はこのツールの収録範囲外
}

/** "2026-08-04" → "2026年8月4日（令和8年8月4日）" */
export function format_hizuke(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return `${y}年${m}月${d}日（${wareki_nen(y, m, d)}${m}月${d}日）`;
}
