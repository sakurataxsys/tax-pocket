// data/toroku_menkyozei_hyo.json を生成する（改正があったら回し直す）
//
//   node tools/fetch_toroku_menkyozei.mjs
//
// 登録免許税法（昭和42年法律第35号）別表第一のうち
//   第1号  不動産の登記
//   第24号 会社又は外国会社の商業登記
// と、租税特別措置法の軽減4条文（72条・72条の2・73条・75条）を
// e-Gov 法令API v2 から取得し、機械的に JSON へ落とす。
// 税額と条文の原文を人が手で書き写さないための道具。**生成物を手で編集しない。**
//
// 別表第一は全体で100号以上・1,414行あるが、扱うのは上の2号だけ（docs/判断ログ.md D-22）。
//
// XML の落とし穴（実測で確認したもの。外すと黙って原文が欠ける）
//   ・号の見出しは1セルの行。号の境界は**この見出し行で検出する**（行番号を焼き込まない）
//   ・表の先頭にヘッダ行（3セル）があるが、最初の見出し行より前なので自然に落ちる
//   ・但書は「第1列が空・第2列 colspan=2」の継続行として入る（第1号に1件・第24号に7件）
//   ・階層は （一） → イ → （１） の3段。「（三の二）」のような枝番があるため、
//     番号は意味を取らずラベルとして持つ
//   ・「千分の一・五」のように中黒つきの小数がある（印紙税の漢数字パーサでは読めない）

import { writeFileSync } from "node:fs";

const TOROKU_ID = "342AC0000000035"; // 登録免許税法
const SOCHI_ID = "332AC0000000026"; // 租税特別措置法
const api = (id, query = "") =>
  `https://laws.e-gov.go.jp/api/2/law_data/${id}?response_format=xml${query}`;
const OUT = new URL("../data/toroku_menkyozei_hyo.json", import.meta.url);

// ------------------------------------------------------------------ 漢数字

const KANSUJI_DIGIT = { 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const KANSUJI_SMALL = { 十: 10, 百: 100, 千: 1000 };
const KANSUJI_BIG = { 万: 1e4, 億: 1e8, 兆: 1e12 };

/** 位取りの漢数字を数値にする。「千五百」→1500 ／「十五万」→150000 ／「一億」→100000000 */
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

/**
 * 「千分の◯」の◯を、整数の分子・分母にする。
 *
 * 「四」      → 分子4  分母1000
 * 「一・五」  → 分子15 分母10000
 * 「二十」    → 分子20 分母1000
 *
 * ★浮動小数を作らない。1.5/1000 を数値で持つと、課税標準を掛けた時点で誤差が乗る。
 *   税額は 課税標準 × 分子 ÷ 分母 の整数演算で求める。
 */
function to_ritsu(kansuji) {
  const [seisu, shosu, ...rest] = String(kansuji).split("・");
  if (rest.length > 0) throw new Error(`小数点が2つ以上あります: "${kansuji}"`);
  if (shosu === undefined) return { 分子: to_number(seisu), 分母: 1000 };
  // 小数部は1桁ずつの漢数字（「五」＝.5）。位取りの漢数字ではない
  for (const ch of shosu) {
    if (!(ch in KANSUJI_DIGIT)) throw new Error(`小数部として読めません: "${kansuji}"`);
  }
  const keta = 10 ** shosu.length;
  const shosu_n = [...shosu].reduce((a, ch) => a * 10 + KANSUJI_DIGIT[ch], 0);
  return { 分子: to_number(seisu) * keta + shosu_n, 分母: 1000 * keta };
}

const GENGO = { 明治: 1867, 大正: 1911, 昭和: 1925, 平成: 1988, 令和: 2018 };
const RE_WAREKI = "(?:明治|大正|昭和|平成|令和)[元〇一二三四五六七八九十]+年[〇一二三四五六七八九十]+月[〇一二三四五六七八九十]+日";

/** 「平成二十五年四月一日」→ "2013-04-01" */
function to_iso_date(wareki) {
  const m = String(wareki).match(
    /(明治|大正|昭和|平成|令和)(元|[〇一二三四五六七八九十]+)年([〇一二三四五六七八九十]+)月([〇一二三四五六七八九十]+)日/,
  );
  if (!m) throw new Error(`和暦の日付として読めません: "${wareki}"`);
  const [, gengo, nen, tsuki, hi] = m;
  const y = GENGO[gengo] + (nen === "元" ? 1 : to_number(nen));
  return `${y}-${String(to_number(tsuki)).padStart(2, "0")}-${String(to_number(hi)).padStart(2, "0")}`;
}

// ------------------------------------------------------------ XML の読み取り

/** タグを落として本文だけにする。読み仮名（<Rt>）は先に捨てる */
function plain(xml) {
  return xml
    .replace(/<Rt>[\s\S]*?<\/Rt>/g, "")
    .replace(/<[^>]+>/g, "")
    .trim();
}

/** 1セル分。<Sentence> を全件つなぐ */
function read_cell(cell_xml) {
  return [...cell_xml.matchAll(/<Sentence[^>]*>([\s\S]*?)<\/Sentence>/g)]
    .map((m) => plain(m[1]))
    .filter((t) => t !== "" && t !== "　")
    .join("\n");
}

/** 1行分。colspan も拾う（但書の継続行の判定に使う） */
function read_row(row_xml) {
  return [...row_xml.matchAll(/<TableColumn([^>]*)>([\s\S]*?)<\/TableColumn>/g)].map((m) => ({
    colspan: Number((m[1].match(/colspan="(\d+)"/) ?? [, "1"])[1]),
    text: read_cell(m[2]),
  }));
}

function law_meta(xml, id) {
  const pick = (tag) => (xml.match(new RegExp(`<${tag}>(.*?)</${tag}>`)) ?? [, ""])[1];
  return {
    法令名: pick("law_title"),
    法令番号: pick("law_num"),
    最終改正: pick("amendment_law_num"),
    施行日: pick("amendment_enforcement_date"),
    url: `https://laws.e-gov.go.jp/law/${id}`,
  };
}

// -------------------------------------------------------------- 税率欄の解析

const RE_TEIRITSU = /^千分の([〇一二三四五六七八九十・]+)$/;
const RE_TEIGAKU = /^一(個|件|箇所)につき([〇一二三四五六七八九十百千万億]+)円$/;
// 第24号（一）カ「一件につき三万円（資本金の額が一億円以下の会社又は一般社団法人等については、一万円）」
const RE_NICHI_TEIGAKU =
  /^一件につき([〇一二三四五六七八九十百千万億]+)円（資本金の額が([〇一二三四五六七八九十百千万億]+)円以下の会社又は一般社団法人等については、([〇一二三四五六七八九十百千万億]+)円）$/;

/**
 * 税率欄の1セルを分類する。
 *
 * 読めない形（第24号（一）ホ・ヘの二段税率）は「扱わない」として原文だけ持ち、
 * 画面では理由を出して計算しない。**黙って落とさない**のがここの要点。
 */
function parse_zeiritsu(text, label) {
  let m;
  if ((m = text.match(RE_TEIRITSU))) {
    const { 分子, 分母 } = to_ritsu(m[1]);
    return { 種別: "定率", 分子, 分母, 原文: text };
  }
  if ((m = text.match(RE_TEIGAKU))) {
    return { 種別: "定額", 単位: `一${m[1]}`, 数量の呼称: m[1], 税額: to_number(m[2]), 原文: text };
  }
  if ((m = RE_NICHI_TEIGAKU.exec(text))) {
    const honsoku = to_number(m[1]);
    const keigen = to_number(m[3]);
    if (keigen >= honsoku) {
      throw new Error(`${label}：括弧内の税額が本体以上です（${honsoku} / ${keigen}）`);
    }
    return {
      種別: "二値定額",
      単位: "一件",
      数量の呼称: "件",
      税額: honsoku,
      しきい値: to_number(m[2]),
      しきい値以下の税額: keigen,
      原文: text,
    };
  }
  return { 種別: "扱わない", 原文: text };
}

// ---------------------------------------------------------------- 但書の解析

const RE_SAITEI =
  /^（これによつて計算した税額が([〇一二三四五六七八九十百千万億]+)円に満たないときは、申請件数一件につき([〇一二三四五六七八九十百千万億]+)円）$/;
// ★これは最低税額ではなく「別建ての額」。最低税額と同じ扱いにすると過大に出る
const RE_BETSUDATE =
  /^（同一の申請書により([〇一二三四五六七八九十]+)個を超える不動産について登記の抹消を受ける場合には、申請件数一件につき([〇一二三四五六七八九十百千万億]+)円）$/;

function parse_tadashigaki(text, label) {
  let m;
  if ((m = text.match(RE_SAITEI))) {
    const a = to_number(m[1]);
    const b = to_number(m[2]);
    if (a !== b) throw new Error(`${label}：但書の2つの金額が一致しません（${a} / ${b}）`);
    return { 種別: "最低税額", 税額: a, 原文: text };
  }
  if ((m = text.match(RE_BETSUDATE))) {
    return {
      種別: "個数超過の別建て",
      個数超: to_number(m[1]),
      税額: to_number(m[2]),
      原文: text,
    };
  }
  throw new Error(`${label}：但書として読めない継続行があります（"${text}"）`);
}

// -------------------------------------------------------------- 階層の組み立て

const RE_DAN1 = /^（[〇一二三四五六七八九十]+(?:の[〇一二三四五六七八九十]+)?）　?/; // （一）（三の二）
const RE_DAN2 = /^[イロハニホヘトチリヌルヲワカヨタレソツネナラムウヰノオク]　/; // イ ロ ハ …
const RE_DAN3 = /^（[０-９]+）　?/; // （１）（２）

/** 段（1〜3）と、ラベル・名称に分ける */
function split_label(text, label) {
  let m;
  if ((m = text.match(RE_DAN1))) return { 段: 1, ラベル: m[0].trim(), 名称: text.slice(m[0].length) };
  if ((m = text.match(RE_DAN2))) return { 段: 2, ラベル: m[0].trim(), 名称: text.slice(m[0].length) };
  if ((m = text.match(RE_DAN3))) return { 段: 3, ラベル: m[0].trim(), 名称: text.slice(m[0].length) };
  throw new Error(`${label}：段を判定できない行があります（"${text.slice(0, 40)}"）`);
}

/**
 * 号のなかの行を木にする。
 *   課税標準・税率がどちらも空の行 ＝ 見出し（親）
 *   それ以外の3セル行             ＝ 葉（計算の対象）
 *   第1列が空・第2列 colspan=2    ＝ 直前の葉に付く但書
 */
function build_tree(rows, gou_label) {
  const root = [];
  const stack = []; // stack[i] = 段 i+1 の直近のノード
  let last_leaf = null;
  let midashi_count = 0;
  let cont_count = 0;

  for (const cells of rows) {
    // ---- 但書の継続行
    if (cells.length === 2 && cells[0].text === "" && cells[1].colspan === 2) {
      if (!last_leaf) throw new Error(`${gou_label}：継続行が葉より先に現れました`);
      if (last_leaf.但書) throw new Error(`${gou_label}：${last_leaf.パス} に但書が2つあります`);
      last_leaf.但書 = parse_tadashigaki(cells[1].text, `${gou_label} ${last_leaf.パス}`);
      cont_count++;
      continue;
    }
    if (cells.length !== 3) {
      throw new Error(`${gou_label}：想定外の列数の行があります（${cells.length}列）`);
    }

    const { 段, ラベル, 名称 } = split_label(cells[0].text, gou_label);
    const oya = 段 === 1 ? null : stack[段 - 2];
    if (段 > 1 && !oya) throw new Error(`${gou_label}：${ラベル} の親が見つかりません`);

    const node = {
      パス: (oya ? `${oya.パス}` : gou_label) + ラベル,
      ラベル,
      名称,
      課税標準: cells[1].text,
      税率: null,
      但書: null,
      子: [],
    };
    (oya ? oya.子 : root).push(node);
    stack[段 - 1] = node;
    stack.length = 段; // 深い段の残りを捨てる

    if (cells[1].text === "" && cells[2].text === "") {
      midashi_count++; // 見出し（親）。税率は子が持つ
      last_leaf = null;
    } else {
      node.税率 = parse_zeiritsu(cells[2].text, `${gou_label} ${node.パス}`);
      last_leaf = node;
    }
  }
  return { 項目: root, 見出し数: midashi_count, 継続行数: cont_count };
}

/** 木を歩いて葉（税率を持つノード）を集める */
function collect_leaves(nodes, out = []) {
  for (const n of nodes) {
    if (n.税率) out.push(n);
    collect_leaves(n.子, out);
  }
  return out;
}

// ------------------------------------------------------------ 別表第一の取得

async function fetch_beppyo_ichi() {
  const res = await fetch(api(TOROKU_ID));
  if (!res.ok) throw new Error(`登録免許税法を取得できませんでした（HTTP ${res.status}）`);
  const xml = await res.text();
  const meta = law_meta(xml, TOROKU_ID);

  const tables = [...xml.matchAll(/<AppdxTable>([\s\S]*?)<\/AppdxTable>/g)].map((m) => m[1]);
  const body = tables.find((t) => /<AppdxTableTitle[^>]*>\s*別表第一/.test(t));
  if (!body) throw new Error("別表第一が見つかりませんでした");

  const rows = [...body.matchAll(/<TableRow>([\s\S]*?)<\/TableRow>/g)].map((m) => read_row(m[1]));

  // 号の見出し＝1セルの行。ここで境界を取る（行番号を焼き込まない）
  const midashi = [];
  rows.forEach((cells, i) => {
    if (cells.length === 1) midashi.push({ i, text: cells[0].text });
  });

  /** 「一　」「二十四　」で始まる見出しから次の見出しまでを切り出す */
  function segment(bangou) {
    const at = midashi.findIndex((m) => m.text.startsWith(`${bangou}　`));
    if (at < 0) throw new Error(`第${bangou}号の見出し行が見つかりませんでした`);
    const start = midashi[at].i;
    const end = at + 1 < midashi.length ? midashi[at + 1].i : rows.length;
    return { 見出し: midashi[at].text, rows: rows.slice(start + 1, end) };
  }

  const gou_list = [
    { 号: 1, 番号: "一", ...segment("一") },
    { 号: 24, 番号: "二十四", ...segment("二十四") },
  ];

  return {
    meta,
    号: gou_list.map((g) => {
      const label = `第${g.号}号`;
      const { 項目, 見出し数, 継続行数 } = build_tree(g.rows, label);
      return { 号: g.号, 番号: g.番号, 見出し: g.見出し, 項目, 見出し数, 継続行数 };
    }),
  };
}

// ------------------------------------------------------- 措置法の軽減4条文の取得

/**
 * 軽減の1条文。次の2つの形がある。
 *   本文に率がある     ：72条の2・73条・75条（「…千分の三とする。」）
 *   各号に率が分かれる ：72条1項（「一 売買による所有権の移転の登記 千分の十五」）
 *
 * 適用期間の起算が条文で違う（判断ログ D-22）。
 *   72条        「その間に…登記を受ける場合」          → 登記を受ける日
 *   72条の2・73・75「その間に…新築し、又は…取得し」   → 新築・取得の日
 * どちらで判定するかは data/toroku_menkyozei.json に人が書く（機械で読めないため）。
 */
function parse_keigen_article(xml, elm) {
  const art = (xml.match(/<Article\b[\s\S]*?<\/Article>/) ?? [""])[0];
  if (!art) throw new Error(`${elm}：条文を取得できませんでした`);
  const 条 = plain((art.match(/<ArticleTitle>([\s\S]*?)<\/ArticleTitle>/) ?? [, ""])[1]);
  const 見出し = plain((art.match(/<ArticleCaption>([\s\S]*?)<\/ArticleCaption>/) ?? [, ""])[1]);

  const p1 = (art.match(/<Paragraph\b[^>]*Num="1"[^>]*>([\s\S]*?)<\/Paragraph>/) ?? [, ""])[1];
  const 本文 = plain((p1.match(/<ParagraphSentence>([\s\S]*?)<\/ParagraphSentence>/) ?? [, ""])[1]);

  const kikan = 本文.match(new RegExp(`(${RE_WAREKI})から(${RE_WAREKI})まで`));
  if (!kikan) throw new Error(`${elm}：適用期間を読み取れませんでした`);

  const base = {
    条,
    見出し,
    適用開始日: to_iso_date(kikan[1]),
    適用終了日: to_iso_date(kikan[2]),
    本文,
  };

  const honbun_ritsu = 本文.match(/千分の([〇一二三四五六七八九十・]+)とする/);
  if (honbun_ritsu) {
    return [{ ...base, キー: elm, 税率: { ...to_ritsu(honbun_ritsu[1]), 原文: `千分の${honbun_ritsu[1]}` } }];
  }

  // 各号に分かれている（72条1項）
  const items = [...p1.matchAll(/<Item\b[^>]*>([\s\S]*?)<\/Item>/g)].map((m) => {
    const 号 = plain((m[1].match(/<ItemTitle>([\s\S]*?)<\/ItemTitle>/) ?? [, ""])[1]);
    const cols = [...m[1].matchAll(/<Column[^>]*>([\s\S]*?)<\/Column>/g)].map((c) => plain(c[1]));
    if (cols.length !== 2) throw new Error(`${elm} 第${号}号：欄が2列ではありません`);
    const r = cols[1].match(/^千分の([〇一二三四五六七八九十・]+)$/);
    if (!r) throw new Error(`${elm} 第${号}号：税率として読めません（"${cols[1]}"）`);
    return { ...base, キー: `${elm}_${号}`, 項号: 号, 対象: cols[0], 税率: { ...to_ritsu(r[1]), 原文: cols[1] } };
  });
  if (items.length === 0) throw new Error(`${elm}：税率も号も読み取れませんでした`);
  return items;
}

async function fetch_keigen() {
  const elms = ["Article_72", "Article_72_2", "Article_73", "Article_75"];
  const out = {};
  let meta = null;
  for (const elm of elms) {
    const res = await fetch(api(SOCHI_ID, `&elm=${elm}`));
    if (!res.ok) throw new Error(`租税特別措置法 ${elm} を取得できませんでした（HTTP ${res.status}）`);
    const xml = await res.text();
    meta ??= law_meta(xml, SOCHI_ID);
    for (const k of parse_keigen_article(xml, elm)) out[k.キー] = k;
  }
  return { meta, 軽減: out };
}

// ------------------------------------------------------------------ 構造の検査

/**
 * 取り込みミスの検知。**税率の期待値はここに書かない**（テスト側に置く）。
 * ここで見るのは「原文の構造が想定どおり読めたか」だけ。
 * 想定が外れたら黙って落とさず、生成を止める。
 */
const KOZO = {
  1: { 葉: 40, 見出し: 11, 継続行: 1, 扱わない: 0, 二値定額: 0 },
  24: { 葉: 29, 見出し: 3, 継続行: 7, 扱わない: 2, 二値定額: 1 },
};

function verify(gou_list, keigen) {
  for (const g of gou_list) {
    const k = KOZO[g.号];
    const leaves = collect_leaves(g.項目);
    const actual = {
      葉: leaves.length,
      見出し: g.見出し数,
      継続行: g.継続行数,
      扱わない: leaves.filter((l) => l.税率.種別 === "扱わない").length,
      二値定額: leaves.filter((l) => l.税率.種別 === "二値定額").length,
    };
    for (const [name, want] of Object.entries(k)) {
      if (actual[name] !== want) {
        throw new Error(
          `第${g.号}号：${name}の数が想定と違います（想定${want} / 実際${actual[name]}）。` +
            "別表が改正された可能性があります。原文を確認してから tools/fetch_toroku_menkyozei.mjs の KOZO を直してください",
        );
      }
    }
  }
  const want_keys = ["Article_72_一", "Article_72_二", "Article_72_2", "Article_73", "Article_75"];
  for (const key of want_keys) {
    if (!keigen[key]) throw new Error(`軽減 ${key} を取り込めませんでした`);
    const v = keigen[key];
    if (!(v.適用開始日 < v.適用終了日)) {
      throw new Error(`軽減 ${key}：適用期間が逆転しています（${v.適用開始日}〜${v.適用終了日}）`);
    }
  }
  if (Object.keys(keigen).length !== want_keys.length) {
    throw new Error(
      `軽減の件数が想定と違います（想定${want_keys.length} / 実際${Object.keys(keigen).length}）`,
    );
  }
}

// ---------------------------------------------------------------- 取得と出力

const beppyo = await fetch_beppyo_ichi();
const keigen = await fetch_keigen();
verify(beppyo.号, keigen.軽減);

const today = new Date().toISOString().slice(0, 10);
const json = {
  名称: "登録免許税額表（別表第一 第1号・第24号／租税特別措置法の軽減）",
  説明:
    "登録免許税法の別表第一のうち第1号（不動産の登記）と第24号（会社の商業登記）、" +
    "および租税特別措置法72条・72条の2・73条・75条を機械的に取り込んだもの。" +
    "tools/fetch_toroku_menkyozei.mjs で再生成する。手で編集しない。",
  取得日: today,
  出典: { 登録免許税法: beppyo.meta, 租税特別措置法: keigen.meta },
  注記: [
    "別表第一は全体で100号以上あるが、収録しているのは第1号と第24号だけ。ほかの号（船舶・航空機・特許権・個人の商業登記・人の資格の登録等）は画面でも扱わない。",
    "税率欄が『千分の◯』『一個（一件・一箇所）につき◯円』『一件につき◯円（資本金の額が◯円以下の…）』のいずれにも当てはまらない行は、種別『扱わない』として原文だけを収録している（第24号（一）ホ・ヘの二段税率）。画面では理由を出して計算しない。",
    "但書には2種類ある。『最低税額』は計算後の下限として効くが、第1号（十五）の『同一の申請書により二十個を超える…』は下限ではなく別建ての額で、置き換えて使う。",
    "軽減の適用期間をどの日で判定するか（登記を受ける日か、新築・取得の日か）は条文で異なるが機械で読めないため、data/toroku_menkyozei.json に人が書く。",
    "登録免許税法17条（仮登記に基づく本登記・借地権者の底地取得の税率の特例）と、非課税・免税の各規定は収録していない。",
  ],
  号: beppyo.号.map((g) => ({
    号: g.号,
    番号: g.番号,
    見出し: g.見出し,
    項目: g.項目,
  })),
  軽減: keigen.軽減,
};

writeFileSync(OUT, JSON.stringify(json, null, 2) + "\n", "utf8");

// ------------------------------------------------------------------ 結果表示

const fmt = (z) => {
  if (z.種別 === "定率") return `${z.分子}/${z.分母}（${z.原文}）`;
  if (z.種別 === "定額") return `${z.単位}につき${z.税額.toLocaleString()}円`;
  if (z.種別 === "二値定額")
    return `${z.単位}につき${z.税額.toLocaleString()}円／${z.しきい値.toLocaleString()}円以下は${z.しきい値以下の税額.toLocaleString()}円`;
  return `★扱わない（${z.原文.slice(0, 30)}…）`;
};

for (const g of json.号) {
  const leaves = collect_leaves(g.項目);
  // 見出しは「二十四　会社又は…」の形。番号を落として名称だけ出す
  const namae = g.見出し.split("\n")[0].split("　").slice(1).join("　");
  console.log(`\n===== 第${g.号}号　${namae.slice(0, 40)}（葉${leaves.length}件）`);
  for (const l of leaves) {
    const tadashi = l.但書 ? `　＋但書[${l.但書.種別}]` : "";
    console.log(
      `  ${l.パス.padEnd(14)} ${l.名称.slice(0, 30).padEnd(32)} ${String(l.課税標準).slice(0, 16).padEnd(18)} ${fmt(l.税率)}${tadashi}`,
    );
  }
}

console.log("\n===== 軽減（租税特別措置法）");
for (const [key, v] of Object.entries(json.軽減)) {
  console.log(
    `  ${key.padEnd(18)} ${v.税率.分子}/${v.税率.分母}（${v.税率.原文}）  ${v.適用開始日}〜${v.適用終了日}  ${v.対象 ?? v.見出し}`,
  );
}

console.log(`\n登録免許税法 最終改正: ${beppyo.meta.最終改正}（施行 ${beppyo.meta.施行日}）`);
console.log(`租税特別措置法 最終改正: ${keigen.meta.最終改正}（施行 ${keigen.meta.施行日}）`);
console.log("書き出しました: data/toroku_menkyozei_hyo.json");
