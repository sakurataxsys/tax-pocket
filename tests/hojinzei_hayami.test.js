// 法人税の実効税率・均等割 早見表のテスト
//
// 3種を必ず置く（CLAUDE.md「税務ロジックの規律」）
//   ① 端数処理  ② 境界値  ③ 改正前後の分岐
//
// ★この画面に法定の端数処理は無い（早見表は目安で、円未満を四捨五入するだけ）。
//   ①の枠は「段階税率の区切り」に置き換える。区切りの取り違えがここでの端数処理にあたる。
//
// 期待値は条文の率から手計算した値を literal で書く。データから引いた値と突き合わせると、
// 率の書き換えを間違えたときにテストも一緒に壊れて検知できなくなるため。
//
// このリポジトリは公開されるため、テストデータはすべて架空の値を使う。

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  build_zeigaku_hyo,
  build_kintowari_hyo,
  calc_hojinzei,
  calc_jigyozei,
  horitsu_jikko_zeiritsu,
} from "../src/calc/hojinzei_hayami.js";

const data = JSON.parse(
  readFileSync(new URL("../data/hojinzei_hayami.json", import.meta.url), "utf8"),
);
const z = data["税率"];

/** 収録範囲内の事業年度開始日（軽減の特例が使える） */
const KEIGEN_ARI = "2026-04-01";
/** 軽減の特例の期限を過ぎた事業年度開始日 */
const KEIGEN_NASHI = "2027-04-01";

// ------------------------------------------------- ① 段階税率の区切り（端数処理の代替）

describe("① 段階税率の区切り", () => {
  test("法人税：年800万円以下だけが軽減の対象", () => {
    // 800万円ちょうど → 全額が軽減部分。8,000,000 × 15% = 1,200,000
    assert.equal(calc_hojinzei(8000000, z, true)["税額"], 1200000);
    // 800万円超 → 超えた部分だけ本則23.2%
    // 1,200,000 + 10,000 × 23.2% = 1,202,320
    assert.equal(calc_hojinzei(8010000, z, true)["税額"], 1202320);
    // 1,000万円 → 1,200,000 + 2,000,000 × 23.2% = 1,664,000
    assert.equal(calc_hojinzei(10000000, z, true)["税額"], 1664000);
  });

  test("事業税：400万・800万の区切りで段階的に計算する", () => {
    // 400万円 → 4,000,000 × 3.5% = 140,000
    assert.equal(calc_jigyozei(4000000, z)["税額"], 140000);
    // 500万円 → 140,000 + 1,000,000 × 5.3% = 193,000
    assert.equal(calc_jigyozei(5000000, z)["税額"], 193000);
    // 800万円 → 140,000 + 4,000,000 × 5.3% = 352,000
    assert.equal(calc_jigyozei(8000000, z)["税額"], 352000);
    // 1,000万円 → 352,000 + 2,000,000 × 7% = 492,000
    assert.equal(calc_jigyozei(10000000, z)["税額"], 492000);
  });

  test("所得800万円の合計が手計算と一致する", () => {
    const r = build_zeigaku_hyo(data, KEIGEN_ARI);
    assert.equal(r.ok, true, r.riyu);
    const g = r["行"].find((x) => x["所得"] === 8000000);
    assert.equal(g["法人税"], 1200000); // 800万 × 15%
    assert.equal(g["地方法人税"], 123600); // 1,200,000 × 10.3%
    assert.equal(g["住民税法人税割"], 84000); // 1,200,000 × (1% + 6%)
    assert.equal(g["事業税"], 352000); // 140,000 + 212,000
    assert.equal(g["特別法人事業税"], 130240); // 352,000 × 37%
    assert.equal(g["合計"], 1889840);
    assert.equal(Math.round(g["負担率"] * 10000) / 100, 23.62); // 23.62%
  });

  test("合計は5つの税目の単純合計で、均等割を含まない", () => {
    const r = build_zeigaku_hyo(data, KEIGEN_ARI);
    for (const g of r["行"]) {
      assert.equal(
        g["合計"],
        g["法人税"] + g["地方法人税"] + g["住民税法人税割"] + g["事業税"] + g["特別法人事業税"],
      );
    }
  });
});

// -------------------------------------------------------------------- ② 境界値

describe("② 境界値", () => {
  test("所得10億円ちょうどは15%、10億円超は17%。ただし年800万円以下の部分にだけ掛かる", () => {
    // 10億円ちょうど：800万 × 15% + 99,200万 × 23.2%
    const a = calc_hojinzei(1000000000, z, true);
    assert.equal(a["軽減の率"], 15);
    assert.equal(a["本則の率"], 23.2);
    assert.equal(a["税額"], 1200000 + 992000000 * 0.232);

    // 10億円超：軽減部分だけ17%に上がる。本則部分は23.2%のまま
    const b = calc_hojinzei(1000010000, z, true);
    assert.equal(b["軽減の率"], 17);
    assert.equal(b["本則の率"], 23.2);
    assert.equal(b["税額"], 8000000 * 0.17 + 992010000 * 0.232);

    // 差は800万円 × 2% ＝ 16万円ぶんだけ（＋所得が1万円増えた分）
    assert.equal(b["税額"] - a["税額"], 160000 + 10000 * 0.232);
  });

  test("均等割：道府県5区分・市町村9区分が条文どおり", () => {
    const k = build_kintowari_hyo(data);
    assert.equal(k["道府県民税"]["条文の区分数"], 5);
    assert.equal(k["市町村民税"]["条文の区分数"], 9);
    // 道府県分（地方税法52条1項）
    assert.deepEqual(
      k["道府県民税"]["区分"].map((x) => x["税額"]),
      [20000, 20000, 50000, 130000, 540000, 800000],
    );
    // 市町村分（地方税法312条1項）
    assert.deepEqual(
      k["市町村民税"]["区分"].map((x) => x["税額"]),
      [50000, 120000, 130000, 150000, 160000, 400000, 410000, 1750000, 3000000],
    );
  });

  test("均等割：従業者50人以下は10億円超で50億円の区切りが無い（非対称）", () => {
    const shi = build_kintowari_hyo(data)["市町村民税"]["区分"];
    const gojunin_ika = shi.filter((x) => x["従業者数"] === "50人以下");
    // 1,000万以下 / 1,000万超1億以下 / 1億超10億以下 / 10億超 の4区分しかない
    assert.equal(gojunin_ika.length, 4);
    assert.deepEqual(
      gojunin_ika.map((x) => x["資本金等の額"]),
      ["1,000万円以下", "1,000万円超 1億円以下", "1億円超 10億円以下", "10億円超"],
    );
    assert.equal(gojunin_ika[3]["税額"], 410000);
  });

  test("赤字でも出る最低額は道府県2万＋市町村5万＝7万円", () => {
    const m = build_kintowari_hyo(data)["赤字でも出る最低額"];
    assert.equal(m["道府県民税"], 20000);
    assert.equal(m["市町村民税"], 50000);
    assert.equal(m["合計"], 70000);
    assert.equal(m["合計"], m["道府県民税"] + m["市町村民税"]);
  });
});

// ------------------------------------------------------------ ③ 改正前後の分岐

describe("③ 改正前後の分岐", () => {
  test("軽減の特例は令和9年3月31日までに開始する事業年度まで", () => {
    const uchi = build_zeigaku_hyo(data, "2027-03-31");
    assert.equal(uchi["軽減の適用"], true);
    assert.equal(uchi["軽減の期限切れ"], false);
    assert.equal(uchi["行"].find((x) => x["所得"] === 8000000)["法人税"], 1200000); // 15%

    const soto = build_zeigaku_hyo(data, "2027-04-01");
    assert.equal(soto["軽減の適用"], false);
    // 期限切れは黙って本則に戻さず、画面に出せるよう結果に持つ
    assert.equal(soto["軽減の期限切れ"], true);
    assert.equal(soto["軽減の適用終了日"], "2027-03-31");
    // 本則19%：8,000,000 × 19% = 1,520,000
    assert.equal(soto["行"].find((x) => x["所得"] === 8000000)["法人税"], 1520000);
  });

  test("期限切れ後は10億円超でも17%にならない（特例そのものが無い）", () => {
    const r = calc_hojinzei(1000010000, z, false);
    assert.equal(r["軽減の率"], 19);
  });

  test("収録開始日（令和7年4月1日）より前に開始する事業年度は組まない", () => {
    const ng = build_zeigaku_hyo(data, "2025-03-31");
    assert.equal(ng.ok, false);
    assert.match(ng.riyu, /令和7年4月1日/);
    const ok = build_zeigaku_hyo(data, "2025-04-01");
    assert.equal(ok.ok, true);
  });
});

// ------------------------------------------------------ ④ 率の取り違え検知

describe("④ 率の取り違え検知", () => {
  test("各率が条文どおりの値である", () => {
    assert.equal(z["法人税"]["本則"], 23.2, "法人税法66条1項");
    assert.equal(z["法人税"]["中小の軽減"], 19, "法人税法66条2項");
    assert.equal(z["法人税"]["軽減の区切り"], 8000000, "年800万円");
    assert.equal(z["法人税の軽減の特例"]["率"], 15, "措法42条の3の2");
    assert.equal(z["法人税の軽減の特例"]["所得が大きい事業年度の率"], 17, "同（年10億円超）");
    assert.equal(z["法人税の軽減の特例"]["所得のしきい値"], 1000000000);
    assert.equal(z["法人税の軽減の特例"]["適用終了日"], "2027-03-31");
    assert.equal(z["地方法人税"]["率"], 10.3, "地方法人税法10条1項");
    assert.equal(z["住民税法人税割"]["道府県の標準税率"], 1, "地方税法51条1項");
    assert.equal(z["住民税法人税割"]["市町村の標準税率"], 6, "地方税法314条の4第1項");
    assert.equal(z["住民税法人税割"]["道府県の制限税率"], 2);
    assert.equal(z["住民税法人税割"]["市町村の制限税率"], 8.4);
    assert.deepEqual(
      z["事業税所得割"]["区分"].map((k) => [k["上限以下"], k["率"]]),
      [
        [4000000, 3.5],
        [8000000, 5.3],
        [null, 7.0],
      ],
      "地方税法72条の24の7第1項3号",
    );
    assert.equal(z["特別法人事業税"]["率"], 37, "特別法人事業税法7条3号");
  });

  test("法定実効税率が33.58%になる（特別法人事業税も損金算入する式）", () => {
    // (0.232 × (1 + 0.103 + 0.07) + 0.07 × 1.37) ÷ (1 + 0.07 × 1.37)
    const r = horitsu_jikko_zeiritsu(data);
    assert.equal(Math.round(r * 10000) / 100, 33.58);

    // ★分母に (1 + 特別法人事業税率) を掛け忘れると 34.4% 前後になり、約0.8ポイント高く出る
    const machigai = (0.232 * 1.173 + 0.07 * 1.37) / (1 + 0.07);
    assert.ok(Math.round(machigai * 10000) / 100 > 34, "掛け忘れると1ポイント近く高く出る");
  });

  test("収録開始日と所得規模の行が入っている", () => {
    assert.equal(data["収録開始日"], "2025-04-01");
    assert.ok(data["所得規模の行"].length >= 5);
    assert.ok(data["所得規模の行"].includes(8000000), "軽減の区切りの行は必ず要る");
    assert.deepEqual(
      [...data["所得規模の行"]].sort((a, b) => a - b),
      data["所得規模の行"],
      "所得規模の行は昇順で並べる",
    );
  });

  test("扱わないものに、軽減が使えない法人の類型が挙がっている", () => {
    const t = data["扱わないもの"].join("\n");
    assert.match(t, /法人税法66条5項/, "大法人の100%子法人等");
    assert.match(t, /適用除外事業者/);
    assert.match(t, /72条の24の7第5項/, "3以上の道府県の資本金1,000万円以上");
    assert.match(t, /外形標準課税/);
    const k = build_kintowari_hyo(data)["判定の注意"].join("\n");
    assert.match(k, /資本準備金/, "資本金等の額と資本金＋資本準備金の大きい方");
    assert.match(k, /その市町村内/, "従業者数は市町村内");
  });
});
