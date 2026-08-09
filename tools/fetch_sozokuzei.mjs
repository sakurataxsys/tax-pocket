// data/sozokuzei_hyo.json を生成する（一度だけ回す。改正があったら回し直す）
//
//   node tools/fetch_sozokuzei.mjs
//
// 相続税法（昭和25年法律73号）16条の表を e-Gov 法令API v2 から取得し、機械的に JSON へ落とす。
// 税率を人が手で書き写さないための道具。**生成物を手で編集しない。**
//
// 表は漢数字（例「三千万円を超え五千万円以下の金額」「百分の二十」）なので算用数字に直す。
// 要素指定（?elm=…）は HTTP 400 になるため、全文を取得して16条を切り出す
// （tools/fetch_shokyakuritsu.mjs と同じ理由・同じ作法）。
//
// ★この表は「超過累進の区分」であって速算表（控除額つき）ではない。
//   控除額は法令に無い便宜的な値なので持たず、区分から直接積み上げて計算する。

import { writeFileSync } from "node:fs";

const LAW_ID = "325AC0000000073";
const API = `https://laws.e-gov.go.jp/api/2/law_data/${LAW_ID}?response_format=xml`;
const OUT = new URL("../data/sozokuzei_hyo.json", import.meta.url);

// ------------------------------------------------------------------ 漢数字

const SUJI = { 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const KURAI = { 十: 10, 百: 100, 千: 1000 };

/**
 * 漢数字を数に直す。「三千万」→ 30000000 ／「千万」→ 10000000 ／「六億」→ 600000000
 * 「千」「十」のように頭の一が省かれる書き方に対応する（法令の表記はこれ）。
 */
function to_number(kansuji) {
  const s = String(kansuji ?? "").trim();
  if (s === "") throw new Error("空の漢数字です");

  let total = 0; // 億・万で確定した分
  let section = 0; // いま組み立てている4桁未満の塊
  let digit = null; // 直前に読んだ一桁

  for (const ch of s) {
    if (ch in SUJI) {
      digit = SUJI[ch];
    } else if (ch in KURAI) {
      // 「千」＝1×1000。頭の一が省かれている場合は1として扱う
      section += (digit ?? 1) * KURAI[ch];
      digit = null;
    } else if (ch === "万" || ch === "億") {
      const unit = ch === "万" ? 10000 : 100000000;
      section += digit ?? 0;
      if (section === 0) throw new Error(`単位の前に数がありません: "${s}"`);
      total += section * unit;
      section = 0;
      digit = null;
    } else {
      throw new Error(`漢数字として読めない文字が入っています: "${s}"（${ch}）`);
    }
  }
  const n = total + section + (digit ?? 0);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`数に直せません: "${s}"`);
  return n;
}

/** 「百分の二十」→ 20 ／「百分の四十五」→ 45 */
function to_percent(text) {
  const m = String(text ?? "").trim().match(/^百分の(.+)$/);
  if (!m) throw new Error(`税率の書き方が想定と違います: "${text}"`);
  const n = to_number(m[1]);
  if (n <= 0 || n >= 100) throw new Error(`税率が範囲外です: "${text}" → ${n}`);
  return n;
}

/**
 * 「千万円以下の金額」→ {下限:null, 上限:10000000}
 * 「三千万円を超え五千万円以下の金額」→ {下限:30000000, 上限:50000000}
 * 「六億円を超える金額」→ {下限:600000000, 上限:null}
 */
function to_kubun(text) {
  const s = String(text ?? "").trim();
  let m = s.match(/^(.+?)円を超え(.+?)円以下の金額$/);
  if (m) return { 下限: to_number(m[1]), 上限: to_number(m[2]) };
  m = s.match(/^(.+?)円以下の金額$/);
  if (m) return { 下限: null, 上限: to_number(m[1]) };
  m = s.match(/^(.+?)円を超える金額$/);
  if (m) return { 下限: to_number(m[1]), 上限: null };
  throw new Error(`区分の書き方が想定と違います: "${s}"`);
}

// ------------------------------------------------------------------ 取得

const res = await fetch(API);
if (!res.ok) throw new Error(`法令APIの取得に失敗しました: HTTP ${res.status}`);
const xml = await res.text();

const start = xml.indexOf('<Article Num="16">');
if (start < 0) throw new Error("16条が見つかりません。法令APIの構造が変わった可能性があります。");
const end = xml.indexOf("</Article>", start);
const article = xml.slice(start, end);

const table_start = article.indexOf("<TableStruct>");
const table_end = article.indexOf("</TableStruct>");
if (table_start < 0 || table_end < 0) {
  throw new Error("16条の表が見つかりません。法令APIの構造が変わった可能性があります。");
}
const table = article.slice(table_start, table_end);

const rows = [...table.matchAll(/<TableRow>([\s\S]*?)<\/TableRow>/g)].map((m) => m[1]);
if (rows.length === 0) throw new Error("表の行が読めません。");

const 税率表 = rows.map((row) => {
  const cells = [...row.matchAll(/<Sentence[^>]*>([\s\S]*?)<\/Sentence>/g)].map((m) =>
    m[1].replace(/<[^>]+>/g, "").trim(),
  );
  if (cells.length !== 2) throw new Error(`1行が2列になっていません: ${JSON.stringify(cells)}`);
  return { ...to_kubun(cells[0]), 税率パーセント: to_percent(cells[1]) };
});

// ------------------------------------------------------------------ 検算

// 区分が下から順に並び、前の行の上限＝次の行の下限で連続していること。
// 途切れていたら取り込みミスなので、生成せずに止める。
税率表.forEach((k, i) => {
  const prev = 税率表[i - 1];
  if (i === 0) {
    if (k.下限 !== null) throw new Error("最初の区分に下限があります。");
  } else if (k.下限 !== prev.上限) {
    throw new Error(`区分が連続していません: ${prev.上限} → ${k.下限}`);
  }
  if (i === 税率表.length - 1) {
    if (k.上限 !== null) throw new Error("最後の区分に上限があります。");
  } else if (!(k.上限 > k.下限)) {
    throw new Error(`区分の上限が下限以下です: ${JSON.stringify(k)}`);
  }
  if (prev && !(k.税率パーセント > prev.税率パーセント)) {
    throw new Error(`税率が上がっていません: ${prev.税率パーセント} → ${k.税率パーセント}`);
  }
});

const today = new Date().toISOString().slice(0, 10);

writeFileSync(
  OUT,
  JSON.stringify(
    {
      名称: "相続税の税率表（相続税法16条の表）",
      取得日: today,
      生成: "node tools/fetch_sozokuzei.mjs（生成物。手で編集しない）",
      出典: [
        {
          名称: "相続税法16条（相続税の総額）の表",
          url: "https://laws.e-gov.go.jp/law/325AC0000000073",
        },
      ],
      注記: [
        "法令の区分（超過累進）をそのまま持つ。速算表の控除額は法令に無いので持たない。",
        "「上限」が null の区分は上限なし（最後の区分）。「下限」が null の区分は下限なし（最初の区分）。",
      ],
      税率表,
    },
    null,
    2,
  ) + "\n",
  "utf8",
);

console.log(`${税率表.length}区分を書き出しました → data/sozokuzei_hyo.json`);
for (const k of 税率表) {
  console.log(`  ${k.下限 ?? "―"} 〜 ${k.上限 ?? "―"} : ${k.税率パーセント}%`);
}
