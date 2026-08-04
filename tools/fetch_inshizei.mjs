// data/inshizei_hyo.json を生成する（改正があったら回し直す）
//
//   node tools/fetch_inshizei.mjs
//
// 印紙税法（昭和42年法律第23号）の別表第一「課税物件表」と、
// 租税特別措置法91条（不動産譲渡契約書・建設工事請負契約書の軽減）を
// e-Gov 法令API v2 から取得し、機械的に JSON へ落とす。
// 税額と条文の原文を人が手で書き写さないための道具。**生成物を手で編集しない。**
//
// 数値は漢数字で位取りされている（「五十億円」＝5,000,000,000）ため、
// 償却率表（tools/fetch_shokyakuritsu.mjs）の桁読みでは足りず、別の解釈が要る。
//
// XML の落とし穴（実測で確認したもの。外すと黙って原文が欠ける）
//   ・第3号と第17号は TableRow が2行に分かれる。継続行の先頭セルは全角空白
//   ・1セルに <Sentence> が複数ある（区分表の1行が1文）。全件を連結する
//   ・第1号の物件名に <Ruby>傭<Rt>よう</Rt></Ruby> がある。<Rt> を先に落とす

import { writeFileSync } from "node:fs";

const INSHI_ID = "342AC0000000023"; // 印紙税法
const SOCHI_ID = "332AC0000000026"; // 租税特別措置法
const api = (id, query = "") =>
  `https://laws.e-gov.go.jp/api/2/law_data/${id}?response_format=xml${query}`;
const OUT = new URL("../data/inshizei_hyo.json", import.meta.url);

// ------------------------------------------------------------------ 漢数字

const KANSUJI_DIGIT = { 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const KANSUJI_SMALL = { 十: 10, 百: 100, 千: 1000 };
const KANSUJI_BIG = { 万: 1e4, 億: 1e8, 兆: 1e12 };

/**
 * 位取りの漢数字を数値にする。
 * 「十万」→100000 ／「五十億」→5000000000 ／「二百」→200 ／「千」→1000 ／「十五万」→150000
 */
function to_number(kansuji) {
  const s = String(kansuji ?? "").trim();
  if (s === "") throw new Error("漢数字が空です");
  let total = 0; // 万・億でくくった確定分
  let section = 0; // 万未満の確定分
  let current = 0; // 直前の1桁
  for (const ch of s) {
    if (ch in KANSUJI_DIGIT) {
      current = KANSUJI_DIGIT[ch];
    } else if (ch in KANSUJI_SMALL) {
      // 「十」は単独で10、「五十」は50
      section += (current || 1) * KANSUJI_SMALL[ch];
      current = 0;
    } else if (ch in KANSUJI_BIG) {
      section += current;
      total += section * KANSUJI_BIG[ch];
      section = 0;
      current = 0;
    } else {
      throw new Error(`漢数字として読めない文字が入っています: "${s}"（${ch}）`);
    }
  }
  const n = total + section + current;
  if (!Number.isFinite(n) || n <= 0) throw new Error(`数値に変換できません: "${s}"`);
  return n;
}

const GENGO = { 明治: 1867, 大正: 1911, 昭和: 1925, 平成: 1988, 令和: 2018 };

/** 「平成二十六年四月一日」→ "2014-04-01" */
function to_iso_date(wareki) {
  const m = String(wareki).match(
    /(明治|大正|昭和|平成|令和)(元|[〇一二三四五六七八九十]+)年([〇一二三四五六七八九十]+)月([〇一二三四五六七八九十]+)日/,
  );
  if (!m) throw new Error(`和暦の日付として読めません: "${wareki}"`);
  const [, gengo, nen, tsuki, hi] = m;
  const y = GENGO[gengo] + (nen === "元" ? 1 : to_number(nen));
  const mm = to_number(tsuki);
  const dd = to_number(hi);
  return `${y}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

// ------------------------------------------------------------ XML の読み取り

/** タグを落として本文だけにする。読み仮名（<Rt>）は先に捨てる */
function plain(xml) {
  return xml
    .replace(/<Rt>[\s\S]*?<\/Rt>/g, "")
    .replace(/<[^>]+>/g, "")
    .trim();
}

/** 1セル分。<Sentence> を全件つなぐ（最初の1つだけ読むと区分表が丸ごと落ちる） */
function read_cell(cell_xml) {
  return [...cell_xml.matchAll(/<Sentence[^>]*>([\s\S]*?)<\/Sentence>/g)]
    .map((m) => plain(m[1]))
    .filter((t) => t !== "" && t !== "　")
    .join("\n");
}

/** 1行分のセル配列 */
function read_row(row_xml) {
  return [...row_xml.matchAll(/<TableColumn[^>]*>([\s\S]*?)<\/TableColumn>/g)].map((m) =>
    read_cell(m[1]),
  );
}

// -------------------------------------------------- 課税標準及び税率の欄の解析

const RE_KUBUN_JOGE = /^(.+?)円を超え(.+?)円以下のもの　(.+?)円$/; // 下限超・上限以下
const RE_KUBUN_IKA = /^(.+?)円以下のもの　(.+?)円$/; // 最下位（下限なし）
const RE_KUBUN_KOE = /^(.+?)円を超えるもの　(.+?)円$/; // 最上位（上限なし）
const RE_TEIGAKU = /^一(通|冊)につき　(.+?)円$/;
const RE_MIDASHI = /^([１２３４])　(.+)$/; // 号のなかの区分の見出し
const RE_YOBISHO = /次に掲げる([^（]+?)(?:（|の区分に応じ)/; // 契約金額・手形金額・券面金額・受取金額

/**
 * 税率欄の1区分。次のどちらかになる。
 *   階級定額：記載金額の区分ごとに税額が決まる（第1〜4号・第17号の1）
 *   定額　　：一通（一冊）につき一定額
 */
function parse_kubun(midashi, lines, gou) {
  const rows = [];
  let teigaku = null;
  let tani = null;
  const hosoku = [];

  for (const line of lines) {
    let m;
    if ((m = line.match(RE_KUBUN_JOGE))) {
      rows.push({ 下限超: to_number(m[1]), 上限以下: to_number(m[2]), 税額: to_number(m[3]) });
    } else if ((m = line.match(RE_KUBUN_KOE))) {
      rows.push({ 下限超: to_number(m[1]), 上限以下: null, 税額: to_number(m[2]) });
    } else if ((m = line.match(RE_KUBUN_IKA))) {
      rows.push({ 下限超: null, 上限以下: to_number(m[1]), 税額: to_number(m[2]) });
    } else if ((m = line.match(RE_TEIGAKU))) {
      if (teigaku !== null) throw new Error(`第${gou}号：定額の行が2つあります`);
      tani = m[1] === "冊" ? "一冊" : "一通";
      teigaku = to_number(m[2]);
    } else {
      hosoku.push(line);
    }
  }

  if (rows.length > 0 && teigaku !== null) {
    throw new Error(`第${gou}号：階級定額と定額が同じ区分に混在しています`);
  }
  if (rows.length === 0 && teigaku === null) {
    throw new Error(`第${gou}号：税額を1つも読み取れませんでした（見出し「${midashi}」）`);
  }

  if (rows.length > 0) {
    const yobisho = hosoku.map((h) => h.match(RE_YOBISHO)).find(Boolean);
    if (!yobisho) throw new Error(`第${gou}号：記載金額の呼称（「次に掲げる◯◯の区分に応じ」）が見つかりません`);
    // 階級定額は必ず「一通につき」（別表第一に一冊単位の階級定額はない）
    return {
      見出し: midashi,
      種別: "階級定額",
      金額の呼称: yobisho[1],
      単位: "一通",
      行: rows,
      補足: hosoku,
    };
  }
  return { 見出し: midashi, 種別: "定額", 金額の呼称: null, 単位: tani, 税額: teigaku, 補足: hosoku };
}

/** 税率欄の全文 → 区分の配列 */
function parse_zeiritsu_ran(text, gou) {
  const lines = text.split("\n").filter((l) => l !== "");
  const segments = [];
  for (const line of lines) {
    const m = line.match(RE_MIDASHI);
    if (m) segments.push({ midashi: m[2], lines: [] });
    else {
      if (segments.length === 0) segments.push({ midashi: null, lines: [] });
      segments[segments.length - 1].lines.push(line);
    }
  }
  return segments.map((s) => parse_kubun(s.midashi, s.lines, gou));
}

/** 階級定額の区分表が連続・単調増加・最上位が上限なしであることを確かめる */
function verify_rows(rows, label) {
  if (rows.length < 2) throw new Error(`${label}：区分が${rows.length}行しかありません`);
  rows.forEach((r, i) => {
    const prev = rows[i - 1];
    if (i === 0) {
      // 先頭は「◯円以下」（本則）か「◯円を超え」（軽減。最下位区分が本則に残るため）のどちらか
      if (r.下限超 !== null && r.上限以下 === null) {
        throw new Error(`${label}：先頭の区分に上限も下限もありません`);
      }
    } else if (r.下限超 !== prev.上限以下) {
      throw new Error(
        `${label}：区分が連続していません（${i}行目の下限 ${r.下限超} ≠ ${i - 1}行目の上限 ${prev.上限以下}）`,
      );
    }
    if (prev && r.税額 <= prev.税額) {
      throw new Error(`${label}：税額が単調増加していません（${i}行目 ${r.税額}円）`);
    }
    if (r.上限以下 !== null && r.下限超 !== null && r.上限以下 <= r.下限超) {
      throw new Error(`${label}：${i}行目の上限が下限以下です`);
    }
  });
  if (rows[rows.length - 1].上限以下 !== null) {
    throw new Error(`${label}：最上位の区分に上限が付いています（「◯円を超えるもの」で終わるはず）`);
  }
}

// ------------------------------------------------------- 非課税物件欄の金額

const RE_HIKAZEI_KINGAKU = /(契約金額|手形金額|受取金額|配当金額|預入額|券面金額)が([〇一二三四五六七八九十百千万億]+)円未満/;

/**
 * 非課税物件欄から金額のしきい値を取り出す。
 * ★このしきい値を無条件に適用してよいかは号によって違う（第8号は「信用金庫その他政令で定める
 *   金融機関の作成する」預貯金証書に限られる）。判断は data/inshizei.json の allowlist に置く。
 */
function parse_hikazei(text) {
  for (const line of text.split("\n")) {
    const m = line.match(RE_HIKAZEI_KINGAKU);
    if (m) return { 呼称: m[1], 金額: to_number(m[2]), 原文: line };
  }
  return null;
}

// ------------------------------------------------------------ 別表第一の取得

async function fetch_beppyo_ichi() {
  const res = await fetch(api(INSHI_ID));
  if (!res.ok) throw new Error(`印紙税法を取得できませんでした（HTTP ${res.status}）`);
  const xml = await res.text();

  const pick = (tag) => (xml.match(new RegExp(`<${tag}>(.*?)</${tag}>`)) ?? [, ""])[1];
  const meta = {
    法令名: pick("law_title"),
    法令番号: pick("law_num"),
    最終改正: pick("amendment_law_num"),
    施行日: pick("amendment_enforcement_date"),
    url: `https://laws.e-gov.go.jp/law/${INSHI_ID}`,
  };

  const tables = [...xml.matchAll(/<AppdxTable>([\s\S]*?)<\/AppdxTable>/g)].map((m) => m[1]);
  const body = tables.find((t) => /<AppdxTableTitle[^>]*>\s*別表第一/.test(t));
  if (!body) throw new Error("別表第一が見つかりませんでした");

  // 表の前に置かれている「課税物件表の適用に関する通則」。
  // 番号（<ItemTitle>）と本文（<Sentence>）が別タグなので、全角空白でつないで1件にする。
  const before = body.slice(0, body.indexOf("<TableStruct"));
  const tsusoku = [...before.matchAll(/<Item\b[\s\S]*?<\/Item>/g)]
    .map((m) => {
      const title = plain((m[0].match(/<ItemTitle>([\s\S]*?)<\/ItemTitle>/) ?? [, ""])[1]);
      const honbun = [...m[0].matchAll(/<Sentence[^>]*>([\s\S]*?)<\/Sentence>/g)]
        .map((s) => plain(s[1]))
        .join("");
      return title === "" ? honbun : `${title}　${honbun}`;
    })
    .filter((t) => /^[１２３４５]　/.test(t));
  if (tsusoku.length !== 5) {
    throw new Error(`通則を5つ読み取れませんでした（${tsusoku.length}件）`);
  }

  // 号ごとに行を組み立てる。継続行（先頭セルが空）は直前の号へ連結する
  const rows = [...body.matchAll(/<TableRow>([\s\S]*?)<\/TableRow>/g)].map((m) => read_row(m[1]));
  const gou_list = [];
  for (const cells of rows) {
    if (cells.length < 5) continue; // 見出し行（番号・課税物件・課税標準及び税率・非課税物件／物件名・定義）
    if (cells[0] === "") {
      const last = gou_list[gou_list.length - 1];
      if (!last) throw new Error("継続行が先頭に現れました");
      for (let j = 1; j < 5; j++) {
        if (cells[j] !== "") last.cells[j] = last.cells[j] === "" ? cells[j] : `${last.cells[j]}\n${cells[j]}`;
      }
    } else {
      gou_list.push({ 号: to_number(cells[0]), cells: [...cells] });
    }
  }

  if (gou_list.length !== 20) throw new Error(`号を20件読み取れませんでした（${gou_list.length}件）`);
  gou_list.forEach((g, i) => {
    if (g.号 !== i + 1) throw new Error(`号の並びが1〜20になっていません（${i + 1}番目が第${g.号}号）`);
  });

  const 号 = gou_list.map((g) => {
    const kubun = parse_zeiritsu_ran(g.cells[3], g.号);
    kubun.forEach((k, i) => {
      if (k.種別 === "階級定額") verify_rows(k.行, `第${g.号}号の区分${i + 1}`);
    });
    return {
      号: g.号,
      物件名: g.cells[1],
      定義: g.cells[2],
      課税標準及び税率: g.cells[3],
      非課税物件: g.cells[4],
      区分: kubun,
      非課税しきい値: parse_hikazei(g.cells[4]),
    };
  });

  return { meta, 通則: tsusoku, 号 };
}

// ---------------------------------------------------------- 措置法91条の取得

/** 措法91条の各項 → 軽減税率表。別表ではなく本文の Item / Column 構造で書かれている */
function parse_keigen_paragraph(para_xml, label) {
  const honbun = plain(
    (para_xml.match(/<ParagraphSentence>([\s\S]*?)<\/ParagraphSentence>/) ?? [, ""])[1],
  );
  const kikan = honbun.match(
    /((?:明治|大正|昭和|平成|令和)[元〇一二三四五六七八九十]+年[〇一二三四五六七八九十]+月[〇一二三四五六七八九十]+日)から((?:明治|大正|昭和|平成|令和)[元〇一二三四五六七八九十]+年[〇一二三四五六七八九十]+月[〇一二三四五六七八九十]+日)までの間に作成される/,
  );
  if (!kikan) throw new Error(`${label}：適用期間を読み取れませんでした`);

  const taisho = honbun.match(/契約金額が([〇一二三四五六七八九十百千万億]+)円を超えるもの/);
  if (!taisho) throw new Error(`${label}：軽減の対象となる下限金額を読み取れませんでした`);

  const rows = [...para_xml.matchAll(/<Item\b[^>]*>([\s\S]*?)<\/Item>/g)].map((m) => {
    const cols = [...m[1].matchAll(/<Column[^>]*>([\s\S]*?)<\/Column>/g)].map((c) => plain(c[1]));
    if (cols.length !== 2) throw new Error(`${label}：号の欄が2列ではありません（${cols.length}列）`);
    const line = `${cols[0]}　${cols[1]}`;
    let m2;
    if ((m2 = line.match(RE_KUBUN_JOGE))) {
      return { 下限超: to_number(m2[1]), 上限以下: to_number(m2[2]), 税額: to_number(m2[3]) };
    }
    if ((m2 = line.match(RE_KUBUN_KOE))) {
      return { 下限超: to_number(m2[1]), 上限以下: null, 税額: to_number(m2[2]) };
    }
    throw new Error(`${label}：区分として読めない行があります（"${line}"）`);
  });
  verify_rows(rows, label);

  return {
    適用開始日: to_iso_date(kikan[1]),
    適用終了日: to_iso_date(kikan[2]),
    軽減の対象となる契約金額の下限超: to_number(taisho[1]),
    行: rows,
    本文: honbun,
  };
}

async function fetch_keigen() {
  const res = await fetch(api(SOCHI_ID, "&elm=Article_91"));
  if (!res.ok) throw new Error(`租税特別措置法91条を取得できませんでした（HTTP ${res.status}）`);
  const xml = await res.text();

  const pick = (tag) => (xml.match(new RegExp(`<${tag}>(.*?)</${tag}>`)) ?? [, ""])[1];
  const meta = {
    法令名: pick("law_title"),
    法令番号: pick("law_num"),
    最終改正: pick("amendment_law_num"),
    施行日: pick("amendment_enforcement_date"),
    url: `https://laws.e-gov.go.jp/law/${SOCHI_ID}`,
  };

  const paras = [...xml.matchAll(/<Paragraph\b[^>]*Num="([12])"[^>]*>([\s\S]*?)<\/Paragraph>/g)];
  const find = (num) => paras.find((p) => p[1] === num);
  const p1 = find("1");
  const p2 = find("2");
  if (!p1 || !p2) throw new Error("措置法91条の1項・2項を取得できませんでした");

  return {
    meta,
    不動産譲渡契約書: { 対象の号: 1, ...parse_keigen_paragraph(p1[2], "措法91条1項") },
    建設工事請負契約書: { 対象の号: 2, ...parse_keigen_paragraph(p2[2], "措法91条2項") },
  };
}

// ------------------------------------------------------- 本則と軽減の突き合わせ

/**
 * 軽減表は本則より1区分少ない。
 * 措法91条が「契約金額が十万円（百万円）を超えるもの」だけを対象にしているため、
 * 本則の最下位区分（第1号「十万円以下のもの」・第2号「百万円以下のもの」）が軽減表に無い。
 * ここを取り違えると、軽減対象の文書で下限以下の金額を引けなくなる。
 */
function verify_keigen_against_honsoku(keigen, honsoku_kubun, label) {
  const honsoku = honsoku_kubun.行;
  if (keigen.行.length !== honsoku.length - 1) {
    throw new Error(
      `${label}：軽減表の区分数が本則−1になっていません（軽減${keigen.行.length} / 本則${honsoku.length}）`,
    );
  }
  const honsoku_kyokai = new Set(honsoku.map((r) => `${r.下限超}-${r.上限以下}`));
  for (const r of keigen.行) {
    if (!honsoku_kyokai.has(`${r.下限超}-${r.上限以下}`)) {
      throw new Error(
        `${label}：軽減表の区分（${r.下限超}円超 ${r.上限以下}円以下）が本則の境界と一致しません`,
      );
    }
  }
  if (keigen.行[0].下限超 !== keigen.軽減の対象となる契約金額の下限超) {
    throw new Error(`${label}：軽減表の先頭の下限が、条文本文の対象下限と一致しません`);
  }
  if (honsoku[0].上限以下 !== keigen.軽減の対象となる契約金額の下限超) {
    throw new Error(
      `${label}：本則の最下位区分の上限（${honsoku[0].上限以下}円）が、軽減の対象下限と一致しません`,
    );
  }
  keigen.行.forEach((r) => {
    const h = honsoku.find((x) => x.下限超 === r.下限超);
    if (r.税額 > h.税額) {
      throw new Error(`${label}：軽減後の税額が本則より高くなっています（${r.下限超}円超の区分）`);
    }
  });
}

// ---------------------------------------------------------------- 取得と出力

const beppyo = await fetch_beppyo_ichi();
const keigen = await fetch_keigen();

verify_keigen_against_honsoku(
  keigen.不動産譲渡契約書,
  beppyo.号[0].区分[0],
  "第1号（不動産譲渡契約書）",
);
verify_keigen_against_honsoku(
  keigen.建設工事請負契約書,
  beppyo.号[1].区分[0],
  "第2号（建設工事請負契約書）",
);

// 継続行の連結が効いていることの検知（黙って原文が欠ける事故を止める）
if (!beppyo.号[2].課税標準及び税率.includes("一覧払")) {
  throw new Error("第3号の税率欄に「一覧払」がありません。継続行の連結が効いていない可能性があります");
}
if (!beppyo.号[16].定義.includes("ニ　受託者")) {
  throw new Error("第17号の定義欄が途中で切れています。継続行の連結が効いていない可能性があります");
}
// 読み仮名の混入検知
if (beppyo.号[0].物件名.includes("傭よう")) {
  throw new Error("物件名に読み仮名が混入しています（<Rt> の除去が効いていません）");
}

const today = new Date().toISOString().slice(0, 10);
const json = {
  名称: "印紙税額表（課税物件表・軽減税率表）",
  説明:
    "印紙税法の別表第一と租税特別措置法91条を機械的に取り込んだもの。" +
    "tools/fetch_inshizei.mjs で再生成する。手で編集しない。",
  取得日: today,
  出典: { 印紙税法: beppyo.meta, 租税特別措置法: keigen.meta },
  注記: [
    "軽減税率表は本則より1区分少ない。措法91条が『契約金額が十万円（百万円）を超えるもの』だけを対象にしているため、本則の最下位区分が軽減表に無い。軽減対象の文書でも、下限以下の金額と記載金額のないものは本則を引く。",
    "非課税しきい値は非課税物件欄から機械的に取り出しただけのもので、無条件に適用してよいとは限らない（第8号は『信用金庫その他政令で定める金融機関の作成する』預貯金証書に限られる）。自動適用してよい号は data/inshizei.json の allowlist で指定する。",
    "課税物件表の適用に関する通則（文書の所属の決定・記載金額の計算等）は原文を収録するだけで、判定には使っていない。どの号に当たるかの判定は人が行う。",
  ],
  課税物件表の適用に関する通則: beppyo.通則,
  号: beppyo.号,
  軽減税率: {
    不動産譲渡契約書: keigen.不動産譲渡契約書,
    建設工事請負契約書: keigen.建設工事請負契約書,
  },
};

writeFileSync(OUT, JSON.stringify(json, null, 2) + "\n", "utf8");

// ------------------------------------------------------------------ 結果表示

for (const g of json.号) {
  const kubun = g.区分
    .map((k) => (k.種別 === "階級定額" ? `階級定額${k.行.length}区分（${k.金額の呼称}）` : `${k.単位}につき${k.税額}円`))
    .join(" ／ ");
  const hikazei = g.非課税しきい値 ? `　非課税<${g.非課税しきい値.金額}円` : "";
  console.log(`第${String(g.号).padStart(2)}号: ${kubun}${hikazei}`);
}
console.log(
  `\n軽減（不動産譲渡）: ${json.軽減税率.不動産譲渡契約書.行.length}区分  ` +
    `${json.軽減税率.不動産譲渡契約書.適用開始日} 〜 ${json.軽減税率.不動産譲渡契約書.適用終了日}`,
);
console.log(
  `軽減（建設工事請負）: ${json.軽減税率.建設工事請負契約書.行.length}区分  ` +
    `${json.軽減税率.建設工事請負契約書.適用開始日} 〜 ${json.軽減税率.建設工事請負契約書.適用終了日}`,
);
console.log(`\n印紙税法 最終改正: ${beppyo.meta.最終改正}（施行 ${beppyo.meta.施行日}）`);
console.log(`措置法   最終改正: ${keigen.meta.最終改正}（施行 ${keigen.meta.施行日}）`);
console.log("書き出しました: data/inshizei_hyo.json");
