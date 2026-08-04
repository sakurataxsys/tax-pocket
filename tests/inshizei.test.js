// 印紙税の計算のテスト
//
// 3種を必ず置く（CLAUDE.md「税務ロジックの規律」）
//   ① 端数処理  ② 境界値  ③ 改正前後の分岐
//
// ★印紙税に円未満・千円未満といった端数処理は存在しない（階級ごとの定額のため）。
//   ①の枠は「区分の境界」に置き換える。「以下」と「を超え」の取り違えがここでの端数処理にあたる。
//
// 期待値は法定金額を literal で書く。データから引いた値と突き合わせると、
// 再生成が壊れたときにテストも一緒に壊れて検知できなくなるため。
//
// このリポジトリは公開されるため、テストデータはすべて架空の値を使う。

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  calc_inshizei,
  pick_bunsho,
  hikiate_kaikyu,
} from "../src/calc/inshizei.js";

const tables = {
  inshizei: JSON.parse(
    readFileSync(new URL("../data/inshizei.json", import.meta.url), "utf8"),
  ),
  inshizei_hyo: JSON.parse(
    readFileSync(new URL("../data/inshizei_hyo.json", import.meta.url), "utf8"),
  ),
};

/** 既定の入力（各テストで必要な項目だけ上書きする） */
function input(over = {}) {
  return {
    sakusei_bi: "2026-08-04",
    key: "1",
    kingaku: 1000000,
    kingaku_nashi: false,
    keigen_taisho: false,
    ...over,
  };
}

/** 税額だけを取り出す。ok でなければテストを落とす */
function zei(over) {
  const r = calc_inshizei(input(over), tables);
  assert.equal(r.ok, true, r.riyu ?? "計算できませんでした");
  return r.zeigaku;
}

// ------------------------------------------------- ① 区分の境界（端数処理の代替）

describe("① 区分の境界（印紙税に端数処理はない）", () => {
  test("第1号 本則：契約金額の境界の上下で税額が変わる", () => {
    // 別表第一 第1号「十万円以下のもの 二百円」「十万円を超え五十万円以下のもの 四百円」
    assert.equal(zei({ kingaku: 100000 }), 200);
    assert.equal(zei({ kingaku: 100001 }), 400);
    assert.equal(zei({ kingaku: 500000 }), 400);
    assert.equal(zei({ kingaku: 500001 }), 1000);
    // 「五百万円を超え千万円以下のもの 一万円」＝1,000万円ちょうどは1万円（2万円ではない）
    assert.equal(zei({ kingaku: 10000000 }), 10000);
    assert.equal(zei({ kingaku: 10000001 }), 20000);
    // 「五十億円を超えるもの 六十万円」
    assert.equal(zei({ kingaku: 5000000000 }), 400000);
    assert.equal(zei({ kingaku: 5000000001 }), 600000);
  });

  test("第1号 軽減：措置法91条1項の区分でも境界は同じ位置", () => {
    const k = (kingaku) => zei({ kingaku, keigen_taisho: true });
    // 措法91条1項「四 五百万円を超え千万円以下のもの五千円」＝1,000万円ちょうどは5,000円
    assert.equal(k(10000000), 5000);
    assert.equal(k(10000001), 10000);
    assert.equal(k(500000), 200);
    assert.equal(k(500001), 500);
    assert.equal(k(5000000001), 480000);
  });

  test("第2号 本則・軽減：請負の境界", () => {
    const h = (kingaku) => zei({ key: "2", kingaku });
    const k = (kingaku) => zei({ key: "2", kingaku, keigen_taisho: true });
    assert.equal(h(1000000), 200);
    assert.equal(h(1000001), 400);
    assert.equal(h(3000000), 1000);
    assert.equal(h(3000001), 2000);
    assert.equal(k(1000001), 200);
    assert.equal(k(2000000), 200);
    assert.equal(k(2000001), 500);
  });

  test("第17号の1：受取金額の境界", () => {
    const r = (kingaku) => zei({ key: "17-1", kingaku });
    assert.equal(r(1000000), 200);
    assert.equal(r(1000001), 400);
    assert.equal(r(1000000000), 150000);
    assert.equal(r(1000000001), 200000);
  });

  test("すべての階級定額の区分表を、全境界の上下1円で総当たりする", () => {
    // 「以下」と「を超え」の取り違えを、号ごとに1件ずつ書かずに検知する
    for (const bunsho of tables.inshizei["文書"]) {
      const gou = tables.inshizei_hyo["号"].find((g) => g["号"] === bunsho["号"]);
      const kubun = gou["区分"][bunsho["使う区分"]];
      if (kubun["種別"] !== "階級定額") continue;
      const shikii = bunsho["非課税しきい値を適用する"] ? gou["非課税しきい値"]["金額"] : 0;

      for (const gyo of kubun["行"]) {
        if (gyo["上限以下"] === null) continue;
        const label = `第${bunsho["号"]}号 ${gyo["上限以下"]}円`;
        if (gyo["上限以下"] >= shikii) {
          assert.equal(
            zei({ key: bunsho.key, kingaku: gyo["上限以下"] }),
            gyo["税額"],
            `${label}ちょうどはこの区分に入るはず`,
          );
        }
        const tsugi = kubun["行"].find((g) => g["下限超"] === gyo["上限以下"]);
        assert.equal(
          zei({ key: bunsho.key, kingaku: gyo["上限以下"] + 1 }),
          tsugi["税額"],
          `${label}＋1円は次の区分に入るはず`,
        );
      }
    }
  });

  test("hikiate_kaikyu は下限超・上限以下のとおりに引き当てる", () => {
    const rows = [
      { 下限超: null, 上限以下: 100, 税額: 1 },
      { 下限超: 100, 上限以下: 200, 税額: 2 },
      { 下限超: 200, 上限以下: null, 税額: 3 },
    ];
    assert.equal(hikiate_kaikyu(rows, 1)["税額"], 1);
    assert.equal(hikiate_kaikyu(rows, 100)["税額"], 1);
    assert.equal(hikiate_kaikyu(rows, 101)["税額"], 2);
    assert.equal(hikiate_kaikyu(rows, 200)["税額"], 2);
    assert.equal(hikiate_kaikyu(rows, 201)["税額"], 3);
  });
});

// ---------------------------------------------------------------- ② 境界値

describe("② 境界値（非課税と、軽減から本則へのフォールバック）", () => {
  test("第1号・第2号：契約金額1万円未満は非課税", () => {
    const r = calc_inshizei(input({ kingaku: 9999 }), tables);
    assert.equal(r.ok, true);
    assert.equal(r.hikazei, true);
    assert.equal(r.zeigaku, 0);
    assert.equal(zei({ kingaku: 10000 }), 200);
    assert.equal(calc_inshizei(input({ key: "2", kingaku: 9999 }), tables).hikazei, true);
    assert.equal(zei({ key: "2", kingaku: 10000 }), 200);
  });

  test("第17号：受取金額5万円未満は、売上代金かどうかにかかわらず非課税", () => {
    // 非課税物件欄1「記載された受取金額が五万円未満の受取書」は号全体に係る。
    // 第17号の2（借入金・保証金の受取書など）を落とすと、非課税の文書に200円と出る。
    for (const key of ["17-1", "17-2"]) {
      assert.equal(
        calc_inshizei(input({ key, kingaku: 49999 }), tables).hikazei,
        true,
        `${key} の49,999円は非課税`,
      );
      assert.equal(zei({ key, kingaku: 50000 }), 200);
    }
  });

  test("第15号は1万円未満、第16号は3千円未満、第3号は10万円未満が非課税", () => {
    assert.equal(calc_inshizei(input({ key: "15", kingaku: 9999 }), tables).hikazei, true);
    assert.equal(zei({ key: "15", kingaku: 10000 }), 200);
    assert.equal(calc_inshizei(input({ key: "16", kingaku: 2999 }), tables).hikazei, true);
    assert.equal(zei({ key: "16", kingaku: 3000 }), 200);
    assert.equal(calc_inshizei(input({ key: "3", kingaku: 99999 }), tables).hikazei, true);
    assert.equal(zei({ key: "3", kingaku: 100000 }), 200);
  });

  test("軽減の対象でも、下限以下の金額は本則を引く", () => {
    // 措法91条1項は「契約金額が十万円を超えるもの」だけが対象。
    // 軽減表には10万円以下の区分が無いので、ここで落ちると引き当てに失敗する。
    const r1 = calc_inshizei(input({ kingaku: 100000, keigen_taisho: true }), tables);
    assert.equal(r1.ok, true);
    assert.equal(r1.zeigaku, 200);
    assert.equal(r1.tekiyo, "本則");
    // 第2号は「百万円を超えるもの」が対象
    const r2 = calc_inshizei(
      input({ key: "2", kingaku: 1000000, keigen_taisho: true }),
      tables,
    );
    assert.equal(r2.zeigaku, 200);
    assert.equal(r2.tekiyo, "本則");
  });

  test("軽減の対象でも、記載金額がなければ本則の200円", () => {
    const r = calc_inshizei(input({ kingaku_nashi: true, keigen_taisho: true }), tables);
    assert.equal(r.ok, true);
    assert.equal(r.zeigaku, 200);
    assert.equal(r.tekiyo, "本則");
    assert.equal(r.hikazei, false);
  });

  test("第3号は記載金額がなければ非課税、第4号は計算しない", () => {
    const r3 = calc_inshizei(input({ key: "3", kingaku_nashi: true }), tables);
    assert.equal(r3.ok, true);
    assert.equal(r3.hikazei, true);
    assert.match(r3.hikazei_riyu, /補充/);

    const r4 = calc_inshizei(input({ key: "4", kingaku_nashi: true }), tables);
    assert.equal(r4.ok, false);
    assert.match(r4.riyu, /株数/);
  });

  test("金額を使わない号は、記載金額の入力によらず定額", () => {
    assert.equal(zei({ key: "5", kingaku: 0 }), 40000); // 合併契約書
    assert.equal(zei({ key: "6", kingaku: 0 }), 40000); // 定款
    assert.equal(zei({ key: "7", kingaku: 0 }), 4000); // 継続的取引の基本となる契約書
    assert.equal(zei({ key: "13", kingaku: 0 }), 200); // 債務の保証
  });

  test("第18〜20号の単位は「一冊」、それ以外は「一通」", () => {
    assert.equal(calc_inshizei(input({ key: "20", kingaku: 0 }), tables).tani, "一冊");
    assert.equal(calc_inshizei(input({ key: "20", kingaku: 0 }), tables).zeigaku, 4000);
    assert.equal(calc_inshizei(input({ key: "5", kingaku: 0 }), tables).tani, "一通");
  });

  test("第8号は金額で非課税と判定しない（作成者の条件が付くため）", () => {
    const r = calc_inshizei(input({ key: "8", kingaku: 5000 }), tables);
    assert.equal(r.ok, true);
    assert.equal(r.hikazei, false);
    assert.equal(r.zeigaku, 200);
    assert.equal(r.kingaku_wo_tsukau, false, "第8号に金額欄は出さない");
  });

  test("金額が必要な号で金額が未入力なら計算しない", () => {
    const r = calc_inshizei(input({ kingaku: 0 }), tables);
    assert.equal(r.ok, false);
    assert.match(r.riyu, /契約金額を入力してください/);
  });
});

// ------------------------------------------------------------ ③ 改正前後の分岐

describe("③ 改正前後の分岐（軽減措置の適用期間）", () => {
  const KEIGEN_KAISHI = "2014-04-01"; // 平成26年4月1日
  const KEIGEN_SHURYO = "2027-03-31"; // 令和9年3月31日

  test("収録開始日より前に作成された文書は計算しない", () => {
    const r = calc_inshizei(input({ sakusei_bi: "2014-03-31" }), tables);
    assert.equal(r.ok, false);
    assert.match(r.riyu, /平成26年4月1日|2014/);
  });

  test("適用開始日ちょうどから軽減が効く", () => {
    const r = calc_inshizei(
      input({ sakusei_bi: KEIGEN_KAISHI, kingaku: 10000000, keigen_taisho: true }),
      tables,
    );
    assert.equal(r.ok, true);
    assert.equal(r.tekiyo, "軽減");
    assert.equal(r.zeigaku, 5000);
  });

  test("適用終了日ちょうどは軽減、その翌日から本則に戻る", () => {
    const zen = calc_inshizei(
      input({ sakusei_bi: KEIGEN_SHURYO, kingaku: 10000000, keigen_taisho: true }),
      tables,
    );
    assert.equal(zen.tekiyo, "軽減");
    assert.equal(zen.zeigaku, 5000);
    assert.equal(zen.keigen_kigen_gire, false);

    const go = calc_inshizei(
      input({ sakusei_bi: "2027-04-01", kingaku: 10000000, keigen_taisho: true }),
      tables,
    );
    assert.equal(go.tekiyo, "本則");
    assert.equal(go.zeigaku, 10000);
    assert.equal(go.keigen_kigen_gire, true, "期限切れを画面に出すための印が立つこと");
  });

  test("軽減のチェックを外すと本則に戻る（軽減が号全体に効いていないこと）", () => {
    // 第1号でも、土地の賃借権の設定・消費貸借・運送は軽減の対象外。
    assert.equal(zei({ kingaku: 10000000, keigen_taisho: true }), 5000);
    assert.equal(zei({ kingaku: 10000000, keigen_taisho: false }), 10000);
  });

  test("軽減の対象でない号でチェックが立っていても本則のまま", () => {
    const r = calc_inshizei(
      input({ key: "17-1", kingaku: 10000000, keigen_taisho: true }),
      tables,
    );
    assert.equal(r.tekiyo, "本則");
    // 第17号「五百万円を超え千万円以下のもの 二千円」（第1号とは区分の切り方が違う）
    assert.equal(r.zeigaku, 2000);
  });
});

// -------------------------------------------------------- ④ 取り込みミス検知

describe("④ 税額表の取り込みミス検知", () => {
  const hyo = tables.inshizei_hyo;

  test("第1号から第20号まで揃っている", () => {
    assert.equal(hyo["号"].length, 20);
    hyo["号"].forEach((g, i) => assert.equal(g["号"], i + 1));
  });

  test("階級定額の区分表は連続・単調増加で、最上位に上限がない", () => {
    for (const g of hyo["号"]) {
      for (const k of g["区分"]) {
        if (k["種別"] !== "階級定額") continue;
        const rows = k["行"];
        rows.forEach((r, i) => {
          if (i > 0) {
            assert.equal(r["下限超"], rows[i - 1]["上限以下"], `第${g["号"]}号の区分が連続していない`);
            assert.ok(r["税額"] > rows[i - 1]["税額"], `第${g["号"]}号の税額が単調増加でない`);
          }
        });
        assert.equal(rows[rows.length - 1]["上限以下"], null, `第${g["号"]}号の最上位に上限が付いている`);
      }
    }
  });

  test("軽減表の区分数は本則−1で、境界は本則の部分集合", () => {
    // 措法91条は「十万円（百万円）を超えるもの」だけを対象にするため、
    // 本則の最下位区分が軽減表に無い。ここを同数だと思い込むと引き当てを誤る。
    const pairs = [
      ["不動産譲渡契約書", 1],
      ["建設工事請負契約書", 2],
    ];
    for (const [name, gou] of pairs) {
      const keigen = hyo["軽減税率"][name];
      const honsoku = hyo["号"].find((g) => g["号"] === gou)["区分"][0]["行"];
      assert.equal(keigen["行"].length, honsoku.length - 1, `${name}の区分数`);
      const kyokai = new Set(honsoku.map((r) => `${r["下限超"]}-${r["上限以下"]}`));
      for (const r of keigen["行"]) {
        assert.ok(
          kyokai.has(`${r["下限超"]}-${r["上限以下"]}`),
          `${name}の区分（${r["下限超"]}円超）が本則の境界にない`,
        );
        const h = honsoku.find((x) => x["下限超"] === r["下限超"]);
        assert.ok(r["税額"] <= h["税額"], `${name}の軽減後の税額が本則より高い`);
      }
      assert.equal(keigen["行"][0]["下限超"], keigen["軽減の対象となる契約金額の下限超"]);
    }
  });

  test("継続行が連結されている（第3号の税率欄・第17号の定義欄）", () => {
    // 別表第一の第3号と第17号は TableRow が2行に分かれる。
    // 継続行を落とすと、号数も区分表も揃ったまま原文だけが欠ける。
    assert.match(hyo["号"][2]["課税標準及び税率"], /一覧払/);
    assert.match(hyo["号"][16]["定義"], /ニ　受託者/);
  });

  test("物件名に読み仮名が混入していない", () => {
    // <Ruby>傭<Rt>よう</Rt></Ruby> を落とし損ねると「傭よう船」になる
    assert.doesNotMatch(hyo["号"][0]["物件名"], /傭よう/);
    assert.match(hyo["号"][0]["物件名"], /傭船契約書/);
  });

  test("課税物件表の適用に関する通則が5つ収録されている", () => {
    assert.equal(hyo["課税物件表の適用に関する通則"].length, 5);
    assert.match(hyo["課税物件表の適用に関する通則"][4], /^５　/);
  });

  test("軽減措置の適用終了日が令和9年3月31日である", () => {
    // ★このテストが落ちたら、軽減措置の期限が動いている。
    //   1) node tools/fetch_inshizei.mjs で税額表を再生成する
    //   2) 新しい期限をここに書き直す（テストの更新は開発者の作業。data/ の差し替えだけでは済まない）
    //   3) docs/改正対応手順.md にも同じことを書いてある
    for (const name of ["不動産譲渡契約書", "建設工事請負契約書"]) {
      assert.equal(
        hyo["軽減税率"][name]["適用終了日"],
        "2027-03-31",
        `${name}の軽減の期限が変わっている。docs/改正対応手順.md の「軽減措置が延長されたとき」を見ること`,
      );
      assert.equal(hyo["軽減税率"][name]["適用開始日"], "2014-04-01");
    }
  });

  test("画面の選択肢が指す号と区分が、税額表に実在する", () => {
    for (const b of tables.inshizei["文書"]) {
      const g = hyo["号"].find((x) => x["号"] === b["号"]);
      assert.ok(g, `第${b["号"]}号が税額表にない`);
      assert.ok(g["区分"][b["使う区分"]], `第${b["号"]}号に区分${b["使う区分"]}がない`);
      if (b["非課税しきい値を適用する"]) {
        assert.ok(g["非課税しきい値"], `第${b["号"]}号に非課税しきい値がない`);
      }
      const nashi = b["記載金額なしの扱い"];
      if (nashi["種別"] === "別の区分") {
        assert.ok(g["区分"][nashi["区分"]], `第${b["号"]}号に区分${nashi["区分"]}がない`);
      }
      assert.ok(pick_bunsho(tables.inshizei, b.key), `key ${b.key} を引けない`);
    }
    assert.equal(tables.inshizei["文書"].length, 21, "第17号を1・2に分けて21件");
  });
});
