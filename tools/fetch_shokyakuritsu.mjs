// data/shokyakuritsu.json を生成する（一度だけ回す。改正があったら回し直す）
//
//   node tools/fetch_shokyakuritsu.mjs
//
// 耐用年数省令（昭和40年大蔵省令15号）の別表第八・第九・第十を
// e-Gov 法令API v2 から取得し、機械的に JSON へ落とす。
// 償却率を人が手で書き写さないための道具。**生成物を手で編集しない。**
//
// 別表の数値は漢数字（例「〇・〇六六六」＝0.0666）なので算用数字に直す。
// 要素指定（?elm=AppdxTable_10）は HTTP 400 になるため、全文を取得して切り出す。

import { writeFileSync } from "node:fs";

const LAW_ID = "340M50000040015";
const API = `https://laws.e-gov.go.jp/api/2/law_data/${LAW_ID}?response_format=xml`;
const OUT = new URL("../data/shokyakuritsu.json", import.meta.url);

/** 取り込む別表と、その適用範囲（取得日）。適用範囲は別表の表題そのものに書かれている */
const TARGETS = [
  {
    key: "定額法",
    appdx: "別表第八",
    columns: ["償却率"],
    適用開始日: "2007-04-01", // 平成19年4月1日
    適用終了日: null,
  },
  {
    key: "定率法250",
    appdx: "別表第九",
    columns: ["償却率", "改定償却率", "保証率"],
    適用開始日: "2007-04-01",
    適用終了日: "2012-03-31", // 平成24年3月31日
  },
  {
    key: "定率法200",
    appdx: "別表第十",
    columns: ["償却率", "改定償却率", "保証率"],
    適用開始日: "2012-04-01", // 平成24年4月1日
    適用終了日: null,
  },
];

// ------------------------------------------------------------------ 漢数字

const KANSUJI = { 〇: "0", 一: "1", 二: "2", 三: "3", 四: "4", 五: "5", 六: "6", 七: "7", 八: "8", 九: "9" };

/**
 * 「〇・〇六六六」→ 0.0666 ／「一〇〇」→ 100 ／ 空文字・罫線（―――――）→ null
 * 罫線が入るのは耐用年数2年の定率法（改定償却率・保証率が無い行）。
 */
function to_number(kansuji) {
  const s = String(kansuji ?? "").trim();
  if (s === "" || /^[―—–－ー-]+$/.test(s)) return null;
  let out = "";
  for (const ch of s) {
    if (ch === "・") out += ".";
    else if (ch in KANSUJI) out += KANSUJI[ch];
    else throw new Error(`漢数字として読めない文字が入っています: "${s}"（${ch}）`);
  }
  const n = Number(out);
  if (!Number.isFinite(n)) throw new Error(`数値に変換できません: "${s}" → "${out}"`);
  return n;
}

// -------------------------------------------------------------------- 解析

/** 別表ごとに本文を切り出す */
function split_appdx(xml) {
  const out = new Map();
  const re = /<AppdxTable>([\s\S]*?)<\/AppdxTable>/g;
  let m;
  while ((m = re.exec(xml))) {
    const body = m[1];
    const title = body.match(/<AppdxTableTitle[^>]*>(.*?)<\/AppdxTableTitle>/);
    if (title) out.set(title[1].trim(), body);
  }
  return out;
}

/** 1行分のセルの文字列を取り出す。空セルは <Sentence ... /> で来る */
function read_cells(row_xml) {
  const cells = [];
  const re = /<TableColumn[^>]*>([\s\S]*?)<\/TableColumn>/g;
  let m;
  while ((m = re.exec(row_xml))) {
    const inner = m[1];
    const s = inner.match(/<Sentence[^>]*>([\s\S]*?)<\/Sentence>/);
    cells.push(s ? s[1].trim() : ""); // 自己終了タグ＝空セル
  }
  return cells;
}

/** 別表本文 → { 耐用年数: { 列名: 値 } } */
function parse_table(body, columns, appdx) {
  const rows = {};
  const re = /<TableRow>([\s\S]*?)<\/TableRow>/g;
  let m;
  let count = 0;
  while ((m = re.exec(body))) {
    const cells = read_cells(m[1]);
    const head = cells[0] ?? "";
    if (head === "" || head === "耐用年数" || head === "年") continue; // 見出し行・単位行
    const nensu = to_number(head);
    if (!Number.isInteger(nensu)) {
      throw new Error(`${appdx}: 耐用年数の欄が整数ではありません（"${head}"）`);
    }
    if (rows[nensu]) throw new Error(`${appdx}: 耐用年数${nensu}年の行が重複しています`);
    if (cells.length !== columns.length + 1) {
      throw new Error(
        `${appdx}: 耐用年数${nensu}年の列数が想定と違います（${cells.length}列。想定${columns.length + 1}列）`,
      );
    }
    const row = {};
    columns.forEach((name, i) => {
      row[name] = to_number(cells[i + 1]);
    });
    rows[nensu] = row;
    count++;
  }
  if (count === 0) throw new Error(`${appdx}: 行を1件も取り出せませんでした`);
  return rows;
}

// ---------------------------------------------------------------- 取得と出力

const res = await fetch(API);
if (!res.ok) throw new Error(`e-Gov API から取得できませんでした（HTTP ${res.status}）`);
const xml = await res.text();

const pick = (tag) => (xml.match(new RegExp(`<${tag}>(.*?)</${tag}>`)) ?? [, ""])[1];
const 法令番号 = pick("law_num");
const 法令名 = pick("law_title");
const 最終改正 = pick("amendment_law_num");
const 施行日 = pick("amendment_enforcement_date");

const appdx = split_appdx(xml);
const 表 = {};
for (const t of TARGETS) {
  const body = appdx.get(t.appdx);
  if (!body) throw new Error(`${t.appdx} が見つかりませんでした`);
  const 表題 = (body.match(/<RelatedArticleNum>(.*?)<\/RelatedArticleNum>/) ?? [, ""])[1].trim();
  表[t.key] = {
    別表: t.appdx,
    表題,
    適用開始日: t.適用開始日,
    適用終了日: t.適用終了日,
    行: parse_table(body, t.columns, t.appdx),
  };
}

const today = new Date().toISOString().slice(0, 10);
const json = {
  名称: "減価償却資産の償却率表",
  説明:
    "耐用年数省令の別表第八・第九・第十を機械的に取り込んだもの。" +
    "tools/fetch_shokyakuritsu.mjs で再生成する。手で編集しない。",
  取得日: today,
  出典: {
    法令名,
    法令番号,
    最終改正,
    施行日,
    url: `https://laws.e-gov.go.jp/law/${LAW_ID}`,
    api: API,
  },
  注記: [
    "別表第七（旧定額法・旧定率法。平成19年3月31日以前に取得した資産）は取り込んでいない。第1版の対象外のため。",
    "耐用年数2年の定率法は償却率1.000で、改定償却率・保証率が別表にない（null）。",
  ],
  表,
};

writeFileSync(OUT, JSON.stringify(json, null, 2) + "\n", "utf8");

for (const [key, t] of Object.entries(表)) {
  const years = Object.keys(t.行).map(Number);
  console.log(
    `${key}（${t.別表}）: ${years.length}行  耐用年数 ${Math.min(...years)}〜${Math.max(...years)}年`,
  );
}
console.log(`最終改正: ${最終改正}（施行 ${施行日}）`);
console.log(`書き出しました: data/shokyakuritsu.json`);
