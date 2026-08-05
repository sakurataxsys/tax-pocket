// 登録免許税の計算のテスト
//
// 3種を必ず置く（CLAUDE.md「税務ロジックの規律」）
//   ① 端数処理  ② 境界値  ③ 改正前後の分岐
// ＋ 税額表の取り込みミス検知（自動生成した表が黙って壊れるのを止める）
//
// 期待値は法定金額・法定税率を literal で書く。データから引いた値と突き合わせると、
// 再生成が壊れたときにテストも一緒に壊れて検知できなくなるため。
//
// このリポジトリは公開されるため、テストデータはすべて架空の値を使う。

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  calc_toroku_menkyozei,
  calc_teiritsu,
  collect_leaves,
  pick_leaf,
  keigen_for_leaf,
  ichinen_go,
} from "../src/calc/toroku_menkyozei.js";

const tables = {
  toroku_menkyozei: JSON.parse(
    readFileSync(new URL("../data/toroku_menkyozei.json", import.meta.url), "utf8"),
  ),
  toroku_menkyozei_hyo: JSON.parse(
    readFileSync(new URL("../data/toroku_menkyozei_hyo.json", import.meta.url), "utf8"),
  ),
};
const hyo = tables.toroku_menkyozei_hyo;

/** 既定の入力（各テストで必要な項目だけ上書きする） */
function input(over = {}) {
  return {
    toki_bi: "2026-08-05",
    path: "第1号（一）",
    kingaku: 10000000,
    suryo: 1,
    keigen_key: null,
    shutoku_bi: null,
    hojin_kubun: "会社",
    ...over,
  };
}

/** 税額だけを取り出す。ok でなければテストを落とす */
function zei(over) {
  const r = calc_toroku_menkyozei(input(over), tables);
  assert.equal(r.ok, true, r.riyu ?? "計算できませんでした");
  return r["税額"];
}

function calc(over) {
  return calc_toroku_menkyozei(input(over), tables);
}

// ------------------------------------------------------------------ ① 端数処理

describe("① 端数処理", () => {
  test("課税標準は千円未満を切り捨てる（国税通則法118条1項）", () => {
    // 所有権の保存＝千分の四。12,345,678円 → 12,345,000円 × 4/1000 = 49,380円
    assert.equal(zei({ kingaku: 12345678 }), 49300); // さらに百円未満切捨て
    const r = calc({ kingaku: 12345678 });
    assert.equal(r["課税標準"], 12345000);
    assert.equal(r["計算額"], 49380);
    assert.equal(r["百円未満切捨て後"], 49300);
  });

  test("課税標準の全額が千円未満のときは千円とする（登録免許税法15条）", () => {
    const r = calc({ kingaku: 999 });
    assert.equal(r["課税標準"], 1000);
    assert.equal(r["課税標準を千円にした"], true);
    // 1,000円 × 4/1000 = 4円 → 百円未満切捨てで0円 → 登免法19条で1,000円
    assert.equal(r["税額"], 1000);
    assert.equal(r["最低税額の適用"], "登免法19条");
  });

  test("税額は百円未満を切り捨てる（国税通則法119条1項）", () => {
    // 1,234,000円 × 4/1000 = 4,936円 → 4,900円
    assert.equal(zei({ kingaku: 1234000 }), 4900);
    // 2,000,000円 × 20/1000 = 40,000円（端数なし）
    assert.equal(zei({ path: "第1号（二）ハ", kingaku: 2000000 }), 40000);
  });

  test("税率を適用して計算した額が千円未満のときは千円とする（登録免許税法19条）", () => {
    // 200,000円 × 4/1000 = 800円 → 千円
    const r = calc({ kingaku: 200000 });
    assert.equal(r["百円未満切捨て後"], 800);
    assert.equal(r["税額"], 1000);
    assert.equal(r["最低税額の適用"], "登免法19条");
    // 250,000円 × 4/1000 = 1,000円ちょうどは19条が働かない
    const r2 = calc({ kingaku: 250000 });
    assert.equal(r2["税額"], 1000);
    assert.equal(r2["最低税額の適用"], null);
  });

  test("軽減の千分の一・五でも整数計算になる（浮動小数の誤差が出ない）", () => {
    // 住宅用家屋の保存＝千分の一・五。33,333,000円 × 15/10000 = 49,999.5円 → 49,900円
    const r = calc({
      path: "第1号（一）",
      kingaku: 33333000,
      keigen_key: "Article_72_2",
      shutoku_bi: "2026-08-01",
    });
    assert.equal(r["適用"], "軽減");
    assert.equal(r["計算額"], 49999.5);
    assert.equal(r["税額"], 49900);
  });

  test("定額課税に端数処理はない（単価×数量）", () => {
    // 第1号（十五）登記の抹消＝一個につき1,000円
    assert.equal(zei({ path: "第1号（十五）", suryo: 3 }), 3000);
    // 第1号（四）地役権の設定＝一個につき1,500円
    assert.equal(zei({ path: "第1号（四）", suryo: 2 }), 3000);
  });
});

// -------------------------------------------------------------------- ② 境界値

describe("② 境界値", () => {
  test("役員変更：資本金1億円ちょうどは1万円、1億円超は3万円（第24号（一）カ）", () => {
    const k = (kingaku) => zei({ path: "第24号（一）カ", kingaku, suryo: 1 });
    assert.equal(k(100000000), 10000); // 「一億円以下の会社」に含まれる
    assert.equal(k(100000001), 30000);
    assert.equal(k(10000000), 10000);
  });

  test("役員変更：一般社団法人等は資本金の額にかかわらず1万円", () => {
    const r = calc({
      path: "第24号（一）カ",
      hojin_kubun: "括弧書き適用",
      kingaku: 0,
      suryo: 1,
    });
    assert.equal(r.ok, true, r.riyu);
    assert.equal(r["税額"], 10000);
  });

  test("役員変更：相互会社は括弧書きの対象外で3万円", () => {
    const r = calc({
      path: "第24号（一）カ",
      hojin_kubun: "括弧書き対象外",
      kingaku: 0,
      suryo: 1,
    });
    assert.equal(r.ok, true, r.riyu);
    assert.equal(r["税額"], 30000);
  });

  test("抹消の但書：20個までは個数×1,000円、20個を超えると一件2万円（別建て）", () => {
    const k = (suryo) => zei({ path: "第1号（十五）", suryo });
    assert.equal(k(19), 19000);
    assert.equal(k(20), 20000); // 「二十個を超える」に当たらない
    assert.equal(k(21), 20000); // 但書。21,000円にはならない
    assert.equal(k(100), 20000);
    // 但書が適用されたことが結果に出る
    assert.equal(calc({ path: "第1号（十五）", suryo: 21 })["但書の適用"]["種別"], "個数超過の別建て");
    assert.equal(calc({ path: "第1号（十五）", suryo: 20 })["但書の適用"], null);
  });

  test("株式会社の設立：最低税額15万円の境界（第24号（一）イ）", () => {
    const k = (kingaku) => zei({ path: "第24号（一）イ", kingaku });
    // 千分の七で15万円になるのは資本金 21,428,571.4…円。21,428,000円 → 149,996円 → 149,900円 < 15万
    assert.equal(k(21428000), 150000);
    assert.equal(k(21429000), 150003 - 3); // 150,003円 → 百円未満切捨てで150,000円
    assert.equal(k(30000000), 210000);
    assert.equal(k(1000000), 150000); // 資本金100万円の設立は15万円
    assert.equal(calc({ path: "第24号（一）イ", kingaku: 1000000 })["最低税額の適用"], "但書");
  });

  test("合同会社の設立は最低6万円、増資は最低3万円", () => {
    assert.equal(zei({ path: "第24号（一）ハ", kingaku: 1000000 }), 60000);
    assert.equal(zei({ path: "第24号（一）ハ", kingaku: 10000000 }), 70000);
    assert.equal(zei({ path: "第24号（一）ニ", kingaku: 1000000 }), 30000);
    assert.equal(zei({ path: "第24号（一）ニ", kingaku: 5000000 }), 35000);
  });

  test("取得後1年以内の要件：1年ちょうどは警告なし、超えると警告", () => {
    const base = { path: "第1号（一）", keigen_key: "Article_72_2", kingaku: 10000000 };
    const ok = calc({ ...base, shutoku_bi: "2025-08-05", toki_bi: "2026-08-05" });
    assert.equal(ok["適用"], "軽減");
    assert.equal(ok["一年の警告"], null);
    const over = calc({ ...base, shutoku_bi: "2025-08-05", toki_bi: "2026-08-06" });
    assert.equal(over["適用"], "軽減"); // 税額は出す。止めない
    assert.match(over["一年の警告"], /1年/);
  });

  test("ichinen_go は日付を1年進める", () => {
    assert.equal(ichinen_go("2025-03-31"), "2026-03-31");
    assert.equal(ichinen_go("2024-02-29"), "2025-02-29"); // 境界の警告にしか使わないので繰上げしない
  });
});

// ------------------------------------------------------------ ③ 改正前後の分岐

describe("③ 改正前後の分岐", () => {
  test("措法72条1項1号（土地の売買）は令和11年3月31日まで", () => {
    const base = { path: "第1号（二）ハ", kingaku: 10000000, keigen_key: "Article_72_一" };
    // 軽減 千分の十五：10,000,000 × 15/1000 = 150,000円
    assert.equal(zei({ ...base, toki_bi: "2029-03-31" }), 150000);
    // 期限翌日は本則 千分の二十：200,000円
    const after = calc({ ...base, toki_bi: "2029-04-01" });
    assert.equal(after["税額"], 200000);
    assert.equal(after["適用"], "本則");
    assert.equal(after["軽減の警告"]["種別"], "期限後");
    assert.equal(after["軽減の警告"]["適用終了日"], "2029-03-31");
  });

  test("措法72条の2・73条・75条は令和9年3月31日まで", () => {
    // 保存（本則 千分の四 → 軽減 千分の一・五）
    const hozon = (toki_bi) =>
      zei({
        path: "第1号（一）",
        kingaku: 10000000,
        keigen_key: "Article_72_2",
        shutoku_bi: toki_bi,
        toki_bi,
      });
    assert.equal(hozon("2027-03-31"), 15000);
    assert.equal(hozon("2027-04-01"), 40000);
    // 移転（本則 千分の二十 → 軽減 千分の三）
    const iten = (toki_bi) =>
      zei({
        path: "第1号（二）ハ",
        kingaku: 10000000,
        keigen_key: "Article_73",
        shutoku_bi: toki_bi,
        toki_bi,
      });
    assert.equal(iten("2027-03-31"), 30000);
    assert.equal(iten("2027-04-01"), 200000);
    // 抵当権の設定（本則 千分の四 → 軽減 千分の一）
    const teito = (toki_bi) =>
      zei({
        path: "第1号（五）",
        kingaku: 10000000,
        keigen_key: "Article_75",
        shutoku_bi: toki_bi,
        toki_bi,
      });
    assert.equal(teito("2027-03-31"), 10000);
    assert.equal(teito("2027-04-01"), 40000);
  });

  test("措法72条1項2号（土地の所有権の信託）は千分の三", () => {
    // 本則（十）イ＝千分の四
    assert.equal(zei({ path: "第1号（十）イ", kingaku: 10000000 }), 40000);
    assert.equal(
      zei({ path: "第1号（十）イ", kingaku: 10000000, keigen_key: "Article_72_二" }),
      30000,
    );
  });

  test("収録開始日（令和4年9月1日）より前は計算しない", () => {
    const ng = calc({ toki_bi: "2022-08-31" });
    assert.equal(ng.ok, false);
    assert.match(ng.riyu, /令和4年9月1日/);
    const ok = calc({ toki_bi: "2022-09-01" });
    assert.equal(ok.ok, true);
  });

  test("軽減の期間は条文ごとに決まった日で判定する", () => {
    // 72条＝登記を受ける日。取得日が期限後でも登記日が期限内なら適用
    const a = calc({
      path: "第1号（二）ハ",
      kingaku: 10000000,
      keigen_key: "Article_72_一",
      toki_bi: "2029-03-31",
      shutoku_bi: "2030-01-01",
    });
    assert.equal(a["適用"], "軽減");
    // 73条＝新築・取得の日。取得日が期限内なら、登記日が期限後でも適用（1年の警告は別に出る）
    const b = calc({
      path: "第1号（二）ハ",
      kingaku: 10000000,
      keigen_key: "Article_73",
      toki_bi: "2027-06-01",
      shutoku_bi: "2027-03-31",
    });
    assert.equal(b["適用"], "軽減");
    assert.equal(b["税額"], 30000);
    // 取得日が期限後なら本則
    const c = calc({
      path: "第1号（二）ハ",
      kingaku: 10000000,
      keigen_key: "Article_73",
      toki_bi: "2027-06-01",
      shutoku_bi: "2027-04-01",
    });
    assert.equal(c["適用"], "本則");
  });
});

// -------------------------------------------------- ④ 税額表の取り込みミス検知

describe("④ 税額表の取り込みミス検知", () => {
  test("収録している号は第1号と第24号だけ", () => {
    assert.deepEqual(
      hyo["号"].map((g) => g["号"]),
      [1, 24],
    );
  });

  test("葉・見出し・但書の数が別表第一の原文どおり", () => {
    const g1 = hyo["号"][0];
    const g24 = hyo["号"][1];
    const leaves1 = collect_leaves(g1["項目"]);
    const leaves24 = collect_leaves(g24["項目"]);
    assert.equal(leaves1.length, 40, "第1号の葉は40件");
    assert.equal(leaves24.length, 29, "第24号の葉は29件");
    assert.equal(leaves1.filter((l) => l["但書"]).length, 1, "第1号の但書は1件");
    assert.equal(leaves24.filter((l) => l["但書"]).length, 7, "第24号の但書は7件");
    // 扱わないのは第24号（一）ホ・ヘの二段税率だけ
    const atsukawanai = [...leaves1, ...leaves24].filter((l) => l["税率"]["種別"] === "扱わない");
    assert.deepEqual(
      atsukawanai.map((l) => l["パス"]),
      ["第24号（一）ホ", "第24号（一）ヘ"],
    );
  });

  test("既知の税率が原文どおりに取り込まれている", () => {
    const ritsu = (path) => {
      const r = pick_leaf(hyo, path)["葉"]["税率"];
      return [r["分子"], r["分母"]];
    };
    assert.deepEqual(ritsu("第1号（一）"), [4, 1000], "所有権の保存＝千分の四");
    assert.deepEqual(ritsu("第1号（二）イ"), [4, 1000], "相続による移転＝千分の四");
    assert.deepEqual(ritsu("第1号（二）ハ"), [20, 1000], "その他の原因による移転＝千分の二十");
    assert.deepEqual(ritsu("第1号（五）"), [4, 1000], "抵当権の設定＝千分の四");
    assert.deepEqual(ritsu("第1号（十）イ"), [4, 1000], "所有権の信託＝千分の四");
    assert.deepEqual(ritsu("第24号（一）イ"), [7, 1000], "株式会社の設立＝千分の七");
  });

  test("既知の定額・二値定額が原文どおり", () => {
    const ha = (path) => pick_leaf(hyo, path)["葉"]["税率"];
    assert.equal(ha("第1号（四）")["税額"], 1500, "地役権の設定＝一個につき千五百円");
    assert.equal(ha("第1号（十五）")["税額"], 1000, "登記の抹消＝一個につき千円");
    assert.equal(ha("第24号（一）ロ")["税額"], 60000, "合名会社等の設立＝一件につき六万円");
    assert.equal(ha("第24号（三）ハ")["税額"], 2000, "清算結了＝一件につき二千円");
    const ka = ha("第24号（一）カ");
    assert.equal(ka["種別"], "二値定額");
    assert.equal(ka["税額"], 30000);
    assert.equal(ka["しきい値"], 100000000);
    assert.equal(ka["しきい値以下の税額"], 10000);
  });

  test("但書が原文どおりに取り込まれている", () => {
    const t = (path) => pick_leaf(hyo, path)["葉"]["但書"];
    assert.deepEqual(
      { ...t("第1号（十五）"), 原文: undefined },
      { 種別: "個数超過の別建て", 個数超: 20, 税額: 20000, 原文: undefined },
    );
    assert.equal(t("第24号（一）イ")["種別"], "最低税額");
    assert.equal(t("第24号（一）イ")["税額"], 150000);
    assert.equal(t("第24号（一）ハ")["税額"], 60000);
    assert.equal(t("第24号（一）ニ")["税額"], 30000);
  });

  test("軽減5件が原文どおりに取り込まれている", () => {
    const k = hyo["軽減"];
    assert.deepEqual(Object.keys(k).sort(), [
      "Article_72_2",
      "Article_72_一",
      "Article_72_二",
      "Article_73",
      "Article_75",
    ]);
    assert.deepEqual([k["Article_72_一"]["税率"]["分子"], k["Article_72_一"]["税率"]["分母"]], [15, 1000]);
    assert.deepEqual([k["Article_72_二"]["税率"]["分子"], k["Article_72_二"]["税率"]["分母"]], [3, 1000]);
    assert.deepEqual([k["Article_72_2"]["税率"]["分子"], k["Article_72_2"]["税率"]["分母"]], [15, 10000]);
    assert.deepEqual([k["Article_73"]["税率"]["分子"], k["Article_73"]["税率"]["分母"]], [3, 1000]);
    assert.deepEqual([k["Article_75"]["税率"]["分子"], k["Article_75"]["税率"]["分母"]], [1, 1000]);
    assert.equal(k["Article_72_一"]["適用開始日"], "2013-04-01");
    assert.equal(k["Article_72_2"]["適用開始日"], "1984-04-01");
  });

  test("設定ファイルの軽減が、実在する葉にだけ紐づいている", () => {
    for (const k of tables.toroku_menkyozei["軽減"]) {
      assert.ok(hyo["軽減"][k["キー"]], `軽減 ${k["キー"]} が税額表にありません`);
      for (const path of k["対象の葉"]) {
        assert.ok(pick_leaf(hyo, path), `軽減 ${k["キー"]} の対象 ${path} が税額表にありません`);
      }
      assert.ok(
        ["登記を受ける日", "新築・取得の日"].includes(k["期間の判定日"]),
        `軽減 ${k["キー"]} の期間の判定日が想定外です`,
      );
    }
    // 葉ごとの注意も、実在する葉にだけ付いていること
    for (const path of Object.keys(tables.toroku_menkyozei["葉ごとの注意"])) {
      assert.ok(pick_leaf(hyo, path), `葉ごとの注意の ${path} が税額表にありません`);
    }
  });

  test("軽減は土地・住宅用家屋を区別する行にだけ紐づく（過剰な紐づけの検知）", () => {
    // （二）ハは土地・建物・全原因を1行にまとめているため、軽減が2つ並ぶ＝相互排他で選ばせる
    const hachi = keigen_for_leaf(tables.toroku_menkyozei, "第1号（二）ハ").map((k) => k["キー"]);
    assert.deepEqual(hachi.sort(), ["Article_72_一", "Article_73"]);
    // 相続・共有物分割の行に軽減が付いていないこと（付くと贈与・相続に軽減が当たる）
    assert.equal(keigen_for_leaf(tables.toroku_menkyozei, "第1号（二）イ").length, 0);
    assert.equal(keigen_for_leaf(tables.toroku_menkyozei, "第1号（二）ロ").length, 0);
    // 信託は（十）イ（所有権）だけ。ロ・ハには付けない
    assert.equal(keigen_for_leaf(tables.toroku_menkyozei, "第1号（十）イ").length, 1);
    assert.equal(keigen_for_leaf(tables.toroku_menkyozei, "第1号（十）ロ").length, 0);
    assert.equal(keigen_for_leaf(tables.toroku_menkyozei, "第1号（十）ハ").length, 0);
  });
});

// -------------------------------------------------------- ⑤ 扱わない登記の扱い

describe("⑤ 扱わない登記", () => {
  test("二段税率の登記は計算せず、理由を返す", () => {
    for (const path of ["第24号（一）ホ", "第24号（一）ヘ"]) {
      const r = calc({ path, kingaku: 10000000 });
      assert.equal(r.ok, false);
      assert.match(r.riyu, /財務省令/);
      assert.match(r["原文"], /千分の一・五/);
    }
  });

  test("収録していない号は引けない", () => {
    const r = calc({ path: "第2号（一）" });
    assert.equal(r.ok, false);
  });
});

// -------------------------------------------------------------- calc_teiritsu 単体

describe("calc_teiritsu の単体", () => {
  test("最低税額は但書 → 登免法19条の順に効き、どちらも千円単位なので順序で結果が変わらない", () => {
    const r1 = calc_teiritsu(1000000, { 分子: 7, 分母: 1000 }, { 種別: "最低税額", 税額: 150000 });
    assert.equal(r1["百円未満切捨て後"], 7000);
    assert.equal(r1["税額"], 150000);
    assert.equal(r1["最低税額の適用"], "但書");

    const r2 = calc_teiritsu(1000000, { 分子: 4, 分母: 1000 }, null);
    assert.equal(r2["税額"], 4000);
    assert.equal(r2["最低税額の適用"], null);
  });
});
