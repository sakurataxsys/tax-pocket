// 表示のための整形。計算はここでしない。

/** 1234567 → "1,234,567" */
export function format_number(n) {
  return Number(n).toLocaleString("ja-JP");
}

/** 1234567 → "1,234,567円" */
export function format_en(n) {
  return `${format_number(n)}円`;
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

/** "2026-08-04" → "2026年8月4日（令和8年8月4日）" */
export function format_hizuke(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const wareki = y >= 2019 ? `令和${y - 2018 === 1 ? "元" : y - 2018}年` : `${y}年`;
  return `${y}年${m}月${d}日（${wareki}${m}月${d}日）`;
}
