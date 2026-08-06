// 別表第五（給与所得控除後の給与等の金額）を原文と全行照合する
//
//   node tools/verify_besshi5.mjs            収録している全年分を照合する
//   node tools/verify_besshi5.mjs 2026        その年分だけ照合する
//
// src/calc/shotokuzei.js の calc_kyuyo_shotoku は、別表第五の表そのものを持たず、
// しきい値と刻みから再現している。再現が原文と1行でも食い違えば、画面には
// **もっともらしい誤った給与所得**が出る。それを機械的に潰すための道具。
//
// ★「現行施行版＝その年分に適用される版」ではない。
//   所得税法の年分改正は、その年の12月1日に施行されて当年分から適用されるのが通例で、
//   成立済み・未施行の改正を見落とすと、いま試算する年分を外す（判断ログ D-28）。
//   そのため、リビジョン一覧から「その年の12月31日までに施行される最後の版」を選ぶ。
//   選んだ版は必ず画面に出す（人が目で確かめられるようにする）。

import { readFileSync } from "node:fs";
import { calc_kyuyo_shotoku } from "../src/calc/shotokuzei.js";
import { pick_version } from "../src/calc/version_pick.js";

const LAW_ID = "340AC0000000033"; // 所得税法
const shotokuzei = JSON.parse(
  readFileSync(new URL("../data/shotokuzei.json", import.meta.url), "utf8"),
);

// ------------------------------------------------------------------ 取得

/** その年分に適用される法令リビジョンIDを選ぶ（本文が空の版は1つ前へ遡る） */
async function pick_revision(nen) {
  const res = await fetch(`https://laws.e-gov.go.jp/api/2/law_revisions/${LAW_ID}`);
  if (!res.ok) throw new Error(`リビジョン一覧を取得できません（${res.status}）`);
  const body = await res.json();
  const list = Array.isArray(body) ? body : (body.revisions ?? body.law_revisions ?? []);
  const kouho = list
    .filter((r) => r.amendment_enforcement_date && r.amendment_enforcement_date <= `${nen}-12-31`)
    .sort((a, b) => (a.amendment_enforcement_date < b.amendment_enforcement_date ? -1 : 1));
  if (kouho.length === 0) throw new Error(`${nen}年分に適用される版が見つかりません`);
  return kouho.reverse();
}

/** 法令の全文を取り、テキストノードを構造ごとに拾えるようにして返す */
async function fetch_law(revision_id) {
  const res = await fetch(
    `https://laws.e-gov.go.jp/api/2/law_data/${revision_id}?law_full_text_format=json`,
  );
  if (!res.ok) return null;
  const body = await res.json();
  return body.law_full_text ?? null;
}

// ------------------------------------------------------------------ 切り出し

function text_of(node) {
  const out = [];
  (function walk(n) {
    if (typeof n === "string") return void out.push(n);
    if (Array.isArray(n)) return void n.forEach(walk);
    if (n && typeof n === "object") walk(n.children);
  })(node);
  return out.join("");
}

/** 別表第五のノードを探す */
function find_besshi5(root) {
  let hit = null;
  (function walk(n) {
    if (hit || !n || typeof n !== "object") return;
    if (Array.isArray(n)) return void n.forEach(walk);
    if (n.tag === "AppdxTable" && text_of(n.children?.[0]).includes("別表第五")) {
      hit = n;
      return;
    }
    walk(n.children);
  })(root);
  return hit;
}

/** 全角数字・読点を落として数値にする。数値でなければ null */
function to_number(s) {
  const t = String(s ?? "")
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[，,\s]/g, "")
    .trim();
  return t !== "" && /^[0-9]+$/.test(t) ? Number(t) : null;
}

/**
 * 別表第五の「以上・未満・給与所得控除後の金額」の三つ組を取り出す。
 *
 * 表は1行に3組ぶんが横に並ぶ体裁で、見出し行や定額区間の行が混ざる。
 * そのため、セルを文書順に平らに並べてから「数値が3つ続く」箇所だけを拾い、
 * ★最後に区分が隙間なく連続していることを検査する（拾い漏れ・拾いすぎの検出）。
 */
function extract_rows(besshi5) {
  const rows_cells = [];
  (function walk(n) {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return void n.forEach(walk);
    if (n.tag === "TableRow") {
      const cells = [];
      (function inner(x) {
        if (!x || typeof x !== "object") return;
        if (Array.isArray(x)) return void x.forEach(inner);
        if (x.tag === "TableColumn") return void cells.push(text_of(x.children));
        inner(x.children);
      })(n.children);
      rows_cells.push(cells);
      return;
    }
    walk(n.children);
  })(besshi5);

  // 1行のなかだけで3セルの窓を滑らせる。行をまたぐと関係のない数字が並んで偽の区分になる。
  // 本物の区分は「以上 < 未満 かつ 幅は刻み以下」「控除後の金額 < 収入」を必ず満たす。
  const by_ijo = new Map();
  for (const cells of rows_cells) {
    for (let i = 0; i + 2 < cells.length; i++) {
      const a = to_number(cells[i]);
      const b = to_number(cells[i + 1]);
      const v = to_number(cells[i + 2]);
      if (a === null || b === null || v === null) continue;
      if (!(a < b && b - a <= 4000 && v < a)) continue;
      const prev = by_ijo.get(a);
      if (!prev || b - a < prev.miman - a) by_ijo.set(a, { ijo: a, miman: b, kingaku: v });
    }
  }
  const rows = [...by_ijo.values()].sort((x, y) => x.ijo - y.ijo);
  for (let i = 1; i < rows.length; i++) {
    if (rows[i - 1].miman !== rows[i].ijo) {
      throw new Error(
        `別表第五の切り出しが連続していません：${rows[i - 1].ijo}〜${rows[i - 1].miman} の次が ${rows[i].ijo}`,
      );
    }
  }
  return rows;
}

// ------------------------------------------------------------------ 照合

async function verify(nen) {
  const setting = pick_version(shotokuzei["版"], nen);
  if (!setting) {
    console.log(`${nen}年分：data/shotokuzei.json に版が無いので飛ばす`);
    return true;
  }

  let root = null;
  let used = null;
  for (const rev of await pick_revision(nen)) {
    const t = await fetch_law(rev.law_revision_id);
    if (t && find_besshi5(t)) {
      root = t;
      used = rev;
      break;
    }
  }
  if (!root) throw new Error(`${nen}年分：別表第五を含む法令本文を取得できません`);

  const rows = extract_rows(find_besshi5(root));
  const b5 = setting["給与所得控除"]["別表第五"];

  console.log(
    `\n=== ${nen}年分（${setting["適用年分表示"]}）` +
      `\n    使った版 : ${used.law_revision_id}（施行 ${used.amendment_enforcement_date}）` +
      `\n    刻みの区分 : ${rows.length}行  ${rows[0].ijo} 〜 ${rows[rows.length - 1].miman}`,
  );

  const chigai = [];
  const check = (shunyu, kitai, doko) => {
    const eta = calc_kyuyo_shotoku(shunyu, setting["給与所得控除"]).kingaku;
    if (eta !== kitai) chigai.push({ shunyu, kitai, eta, doko });
  };

  // ① 刻みの区分：下限・下限+1円・上限−1円のすべてで、その区分の金額になること
  for (const r of rows) {
    check(r.ijo, r.kingaku, "区分の下限");
    check(r.ijo + 1, r.kingaku, "区分の下限+1円");
    check(r.miman - 1, r.kingaku, "区分の上限−1円");
  }

  // ② 所得が零となる区間と、収入から定額を引く区間（表の文言どおりに検算する）
  const zero_max = b5["所得が零となる収入の上限"];
  const teigaku_max = b5["収入から定額を引く区間の上限"];
  const teigaku = b5["その区間の定額"];
  check(0, 0, "収入0円");
  check(zero_max - 1, 0, "所得が零となる区間の上限−1円");
  check(zero_max, zero_max - teigaku, "定額を引く区間の下限");
  check(teigaku_max - 1, teigaku_max - 1 - teigaku, "定額を引く区間の上限−1円");

  // ③ 表の始まりが、定額を引く区間の上限とつながっていること
  if (rows[0].ijo !== teigaku_max) {
    chigai.push({
      shunyu: rows[0].ijo,
      kitai: teigaku_max,
      eta: rows[0].ijo,
      doko: "data の「収入から定額を引く区間の上限」が別表第五の刻み開始額と違う",
    });
  }
  // ④ 表の終わりが、別表第五を適用する上限とつながっていること
  if (rows[rows.length - 1].miman !== b5["適用する収入の上限"]) {
    chigai.push({
      shunyu: rows[rows.length - 1].miman,
      kitai: b5["適用する収入の上限"],
      eta: rows[rows.length - 1].miman,
      doko: "data の「適用する収入の上限」が別表第五の終わりと違う",
    });
  }

  if (chigai.length === 0) {
    console.log(`    → 全 ${rows.length * 3 + 4} 点が一致`);
    return true;
  }
  console.log(`    → ★不一致 ${chigai.length} 件（先頭10件）`);
  for (const c of chigai.slice(0, 10)) {
    console.log(`      収入 ${c.shunyu}：表 ${c.kitai} / 実装 ${c.eta}（${c.doko}）`);
  }
  return false;
}

// ------------------------------------------------------------------ 入口

const arg = process.argv[2];
const nen_list = arg
  ? [Number(arg)]
  : shotokuzei["版"].map((v) => v["適用開始年"]);

let ok = true;
for (const nen of nen_list) {
  ok = (await verify(nen)) && ok;
}
console.log(ok ? "\n別表第五：すべて一致\n" : "\n別表第五：不一致あり\n");
process.exit(ok ? 0 : 1);
