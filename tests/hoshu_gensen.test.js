// 報酬・料金等に対する源泉徴収の判定と税額のテスト
//
// 3種を必ず置く（CLAUDE.md「税務ロジックの規律」）
//   ① 端数処理  ② 境界値  ③ 改正前後の分岐
//
// ★この画面の主役は税額ではなく「源泉徴収が必要な範囲の区別」なので、
//   判定の分岐（必要／不要／判定できません）を税額と同じ重さで検査する。
//   とくに「税額を計算しない」ことが「不要」に化けないことを固定する。
//
// このリポジトリは公開されるため、テストデータはすべて架空の値を使う。

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  HANTEI,
  calc_hoshu_gensen,
  calc_kojo,
  pick_hoshu_version,
  pick_kubun,
  chui_for_kubun,
  needs_kyuyo_nyuryoku,
} from "../src/calc/hoshu_gensen.js";

const hoshu_gensen = JSON.parse(
  readFileSync(new URL("../data/hoshu_gensen.json", import.meta.url), "utf8"),
);
const income_tax_rates = JSON.parse(
  readFileSync(new URL("../data/income_tax_rates.json", import.meta.url), "utf8"),
);
const tables = { hoshu_gensen, income_tax_rates };

const genko_ban = hoshu_gensen["版"][0];

/** 既定の入力（各テストで必要な項目だけ上書きする） */
function input(over = {}) {
  return {
    shiharai_bi: "2026-09-07",
    shiharaisaki: "kojin",
    shiharaisha: "kojin-igai",
    kubun_key: "2-a",
    bar_keieisha: false,
    kingaku: 100000,
    kyuyo_gaku: 0,
    ...over,
  };
}

// ------------------------------------------------------------------ ① 端数処理

describe("端数処理（復興財確法31条2項）", () => {
  test("所得税と復興特別所得税の合計額で1円未満を切り捨てる", () => {
    // 33,333 × 10.21% = 3,403.29… → 3,403円
    // ★所得税 3,333円（切捨て済み）に 2.1% を掛けると 3,402円になり、1円ずれる。
    //   条文は「これらの確定金額の合計額によって行い」と定めるので、掛けてから1回だけ切り捨てる
    const r = calc_hoshu_gensen(input({ kingaku: 33333 }), tables);
    assert.equal(r.zeigaku, 3403);
    assert.notEqual(r.zeigaku, 3402);
  });

  test("先に所得税を切り捨てるとずれる例を、ほかの金額でも固定する", () => {
    // 9,999 × 10.21% = 1,020.897… → 1,020円（所得税を先に切ると 999 + 20 = 1,019円）
    assert.equal(calc_hoshu_gensen(input({ kingaku: 9999 }), tables).zeigaku, 1020);
    // 12,345 × 10.21% = 1,260.4… → 1,260円（所得税を先に切ると 1,234 + 25 = 1,259円）
    assert.equal(calc_hoshu_gensen(input({ kingaku: 12345 }), tables).zeigaku, 1260);
  });

  test("端数が出ない金額はそのまま", () => {
    // 100,000 × 10.21% = 10,210円
    assert.equal(calc_hoshu_gensen(input({ kingaku: 100000 }), tables).zeigaku, 10210);
  });
});

// -------------------------------------------------------------------- ② 境界値

describe("境界値（所法205条1号の100万円）", () => {
  test("ちょうど100万円は全額に10.21%", () => {
    const r = calc_hoshu_gensen(input({ kingaku: 1000000 }), tables);
    assert.equal(r.zeigaku, 102100);
    assert.equal(r.keisan.chouka_ari, false);
  });

  test("100万円を1円超えると、超えた部分だけ20.42%", () => {
    // 1,000,000×10.21% + 1×20.42% = 102,100.2042… → 102,100円
    const r = calc_hoshu_gensen(input({ kingaku: 1000001 }), tables);
    assert.equal(r.zeigaku, 102100);
    assert.equal(r.keisan.chouka_ari, true);
  });

  test("国税庁が示す例（150万円）と一致する", () => {
    // （150万円 − 100万円）×20.42% + 102,100円 = 204,200円（タックスアンサー No.2798）
    assert.equal(calc_hoshu_gensen(input({ kingaku: 1500000 }), tables).zeigaku, 204200);
  });

  test("205条1号のすべての区分で100万円超の割増しが働く", () => {
    // ★2-a だけで検査していたため、1号・4-a を2号の枝に落とす誤りが素通りしていた
    for (const key of ["1", "2-a", "4-a"]) {
      const r = calc_hoshu_gensen(input({ kubun_key: key, kingaku: 1500000 }), tables);
      assert.equal(r.zeigaku, 204200, `${key} に割増しが働いていない`);
      assert.equal(r.keisan.chouka_ari, true, `${key} が超過なしになっている`);
    }
  });

  test("知らない税率区分は、黙って別の計算に落とさず税額を出さない", () => {
    // data の文字が1字違っただけで100万円超の割増しが消えると、過少徴収が固定される
    const kowashi = JSON.parse(JSON.stringify(hoshu_gensen));
    kowashi["版"][0]["区分"].find((k) => k.key === "1")["税率区分"] = "205条１号";
    const r = calc_hoshu_gensen(input({ kubun_key: "1", kingaku: 1500000 }), {
      hoshu_gensen: kowashi,
      income_tax_rates,
    });
    assert.equal(r.hantei, HANTEI.必要);
    assert.equal(r.zeigaku, null);
    assert.ok(r.keisan_shinai_riyu);
  });

  test("控除の「給与を差し引く」が欠けたとき、控除しすぎた税額を出さない", () => {
    // 欠けると false と同じ扱いになり、その月の給与等を差し引かないまま
    // 控除額12万円が丸ごと効いて過少徴収になる
    const kowashi = JSON.parse(JSON.stringify(hoshu_gensen));
    delete kowashi["版"][0]["区分"].find((k) => k.key === "4-b")["控除"]["給与を差し引く"];
    const r = calc_hoshu_gensen(
      input({ kubun_key: "4-b", kingaku: 200000, kyuyo_gaku: 50000 }),
      { hoshu_gensen: kowashi, income_tax_rates },
    );
    assert.equal(r.hantei, HANTEI.必要);
    assert.equal(r.zeigaku, null);
  });

  test("税率のキーが欠けたとき、NaN を税額として出さない", () => {
    const kowashi = JSON.parse(JSON.stringify(hoshu_gensen));
    delete kowashi["版"][0]["税率"]["基本パーセント"];
    const r = calc_hoshu_gensen(input(), { hoshu_gensen: kowashi, income_tax_rates });
    assert.equal(r.zeigaku, null);
    assert.ok(r.keisan_shinai_riyu);
  });

  test("復興特別所得税の乗率が文字列でも、税額が10倍にならない", () => {
    // (100 + "2.1") が文字列連結になると分子が 10021 になる
    const moji = {
      ...income_tax_rates,
      版: [{ ...income_tax_rates["版"][0], 復興特別所得税率パーセント: "2.1" }],
    };
    const r = calc_hoshu_gensen(input({ kingaku: 33333 }), {
      hoshu_gensen,
      income_tax_rates: moji,
    });
    assert.equal(r.zeigaku, 3403);
  });
});

describe("境界値（所令322条の控除）", () => {
  test("司法書士等はちょうど1万円で税額0", () => {
    const r = calc_hoshu_gensen(input({ kubun_key: "2-b", kingaku: 10000 }), tables);
    assert.equal(r.zeigaku, 0);
    assert.equal(r.keisan.zangaku, 0);
  });

  test("司法書士等で1万円未満でも、残額をマイナスにしない", () => {
    const r = calc_hoshu_gensen(input({ kubun_key: "2-b", kingaku: 3000 }), tables);
    assert.equal(r.zeigaku, 0);
    assert.equal(r.keisan.zangaku, 0);
  });

  test("司法書士等は1万円を引いた残額に10.21%", () => {
    // (50,000 − 10,000) × 10.21% = 4,084円
    const r = calc_hoshu_gensen(input({ kubun_key: "2-b", kingaku: 50000 }), tables);
    assert.equal(r.zeigaku, 4084);
    assert.equal(r.keisan.kojo, 10000);
  });

  test("司法書士等には100万円超の割増しが働かない（205条2号は一律10%）", () => {
    // (1,500,000 − 10,000) × 10.21% = 152,129円
    const r = calc_hoshu_gensen(input({ kubun_key: "2-b", kingaku: 1500000 }), tables);
    assert.equal(r.zeigaku, 152129);
    assert.equal(r.keisan.chouka_ari, false);
  });

  test("職業拳闘家は1回5万円を差し引く", () => {
    // (200,000 − 50,000) × 10.21% = 15,315円
    const r = calc_hoshu_gensen(input({ kubun_key: "4-c", kingaku: 200000 }), tables);
    assert.equal(r.keisan.kojo, 50000);
    assert.equal(r.zeigaku, 15315);
  });

  test("外交員等は、その月の給与等の額を12万円から差し引く", () => {
    const kubun = pick_kubun(genko_ban, "4-b");
    assert.equal(calc_kojo(kubun, 0), 120000);
    assert.equal(calc_kojo(kubun, 50000), 70000);
  });

  test("外交員等で給与等が12万円以上のとき、控除額は0を下回らない", () => {
    const kubun = pick_kubun(genko_ban, "4-b");
    assert.equal(calc_kojo(kubun, 120000), 0);
    assert.equal(calc_kojo(kubun, 300000), 0);
    // (200,000 − 0) × 10.21% = 20,420円
    const r = calc_hoshu_gensen(
      input({ kubun_key: "4-b", kingaku: 200000, kyuyo_gaku: 300000 }),
      tables,
    );
    assert.equal(r.zeigaku, 20420);
  });
});

// ----------------------------------------------- ③ 改正前後の分岐（版の切り替え）

describe("版の分岐", () => {
  test("収録開始日より前の支払は計算しない", () => {
    const r = calc_hoshu_gensen(input({ shiharai_bi: "2012-12-31" }), tables);
    assert.equal(r.ok, false);
    assert.match(r.riyu, /平成25年1月1日/);
  });

  test("収録開始日ちょうどは扱う", () => {
    const r = calc_hoshu_gensen(input({ shiharai_bi: "2013-01-01" }), tables);
    assert.equal(r.ok, true);
  });

  test("適用終了日を過ぎた支払日では、版が見つからず null を返す", () => {
    // ★令和20年以後の版は先回りして data に書かない（furusato.json と同じ作法）。
    //   ここは合成データで、期限が来たときに黙って古い版を使わないことだけを固定する
    const uchikiri = [
      { 適用開始日: "2013-01-01", 適用終了日: "2037-12-31", 区分: [] },
    ];
    assert.notEqual(pick_hoshu_version(uchikiri, "2037-12-31"), null);
    assert.equal(pick_hoshu_version(uchikiri, "2038-01-01"), null);
  });

  test("税率表の版が無い年は、税額を出さずに理由を返す（判定は残す）", () => {
    // 復興特別所得税が終わったのに income_tax_rates.json を直していない状態を作る
    const furui = {
      ...income_tax_rates,
      版: [{ ...income_tax_rates["版"][0], 適用終了年: 2037 }],
    };
    const r = calc_hoshu_gensen(input({ shiharai_bi: "2038-04-01" }), {
      hoshu_gensen,
      income_tax_rates: furui,
    });
    assert.equal(r.hantei, HANTEI.必要);
    assert.equal(r.zeigaku, null);
    assert.match(r.keisan_shinai_riyu, /税率表/);
  });

  test("復興特別所得税の乗率は income_tax_rates.json から取る（重複して持たない）", () => {
    // 注記の本文では触れてよい。禁じたいのは「数値をこのファイルにも持つこと」なので、
    // 版の中に乗率のキーが生えていないことを見る
    for (const ban of hoshu_gensen["版"]) {
      assert.ok(!Object.hasOwn(ban, "復興特別所得税率パーセント"));
      assert.ok(!Object.hasOwn(ban["税率"], "復興特別所得税率パーセント"));
    }
    const r = calc_hoshu_gensen(input(), tables);
    assert.equal(r.keisan.fukko_ritsu_percent, 2.1);
  });
});

// ------------------------------------------------------------------ 判定の分岐

describe("判定：支払先", () => {
  test("登記された法人への支払は不要", () => {
    const r = calc_hoshu_gensen(input({ shiharaisaki: "hojin" }), tables);
    assert.equal(r.hantei, HANTEI.不要);
    assert.equal(r.zeigaku, null);
    assert.match(r.hantei_riyu, /居住者/); // 204条1項の柱書が理由として出ていること
  });

  test("法人格のない団体への支払は必要（所基通204-1）", () => {
    const r = calc_hoshu_gensen(input({ shiharaisaki: "dantai" }), tables);
    assert.equal(r.hantei, HANTEI.必要);
    assert.equal(r.zeigaku, 10210);
    assert.match(r.hantei_riyu, /立証/);
  });

  test("非居住者は「不要」ではなく「判定できません」", () => {
    const r = calc_hoshu_gensen(input({ shiharaisaki: "hikyojusha" }), tables);
    assert.equal(r.hantei, HANTEI.判定不可);
    assert.notEqual(r.hantei, HANTEI.不要);
    assert.equal(r.zeigaku, null);
  });

  test("★法人への8号（馬主の競馬の賞金を含む）は「不要」と言い切らない", () => {
    // 8号には広告宣伝の賞金（法人なら不要）と馬主の競馬の賞金（法人でも必要）が入っている。
    // 見出しが結論である以上、この組み合わせだけ本文が見出しを覆すことがあってはならない
    const r = calc_hoshu_gensen(
      input({ shiharaisaki: "hojin", kubun_key: "8" }),
      tables,
    );
    assert.equal(r.hantei, HANTEI.判定不可);
    assert.notEqual(r.hantei, HANTEI.不要);
    assert.match(r.hantei_riyu, /馬主/);
  });

  test("法人への8号以外は不要のまま", () => {
    for (const key of ["1", "2-a", "2-b", "4-a", "5", "6", "7"]) {
      const r = calc_hoshu_gensen(
        input({ shiharaisaki: "hojin", kubun_key: key, bar_keieisha: true }),
        tables,
      );
      assert.equal(r.hantei, HANTEI.不要, `${key} が不要になっていない`);
    }
  });
});

describe("判定：支払者（所法204条2項2号）", () => {
  const nashi = { shiharaisha: "kyuyo-nashi" };

  test("給与を支払っていない個人が支払う1号・2号・4号・5号・7号・8号は不要", () => {
    for (const key of ["1", "2-a", "2-b", "4-a", "4-b", "4-c", "5", "7", "8"]) {
      const r = calc_hoshu_gensen(input({ ...nashi, kubun_key: key }), tables);
      assert.equal(r.hantei, HANTEI.不要, `${key} が不要になっていない`);
      assert.equal(r.zeigaku, null);
    }
  });

  test("6号だけは、給与を支払っていない個人でも例外", () => {
    const r = calc_hoshu_gensen(
      input({ ...nashi, kubun_key: "6", bar_keieisha: true }),
      tables,
    );
    assert.equal(r.hantei, HANTEI.必要);
  });

  test("給与を支払っている個人は、納付税額がなくても必要", () => {
    const r = calc_hoshu_gensen(input({ shiharaisha: "kyuyo-ari" }), tables);
    assert.equal(r.hantei, HANTEI.必要);
    assert.equal(r.zeigaku, 10210);
  });
});

describe("判定：6号の例外（所法204条2項3号）", () => {
  test("バー等の経営者が支払うなら必要", () => {
    const r = calc_hoshu_gensen(input({ kubun_key: "6", bar_keieisha: true }), tables);
    assert.equal(r.hantei, HANTEI.必要);
  });

  test("バー等の経営者以外が支払うなら不要", () => {
    const r = calc_hoshu_gensen(input({ kubun_key: "6", bar_keieisha: false }), tables);
    assert.equal(r.hantei, HANTEI.不要);
  });

  test("★未回答を「不要」に落とさない", () => {
    // チェック欄で受けていたころは、6号を選んだだけで「不要」と出ていた。
    // 未回答のうちは結論を出さず、聞くべきことだけを返す
    for (const mikaito of [null, undefined, "", "no"]) {
      const r = calc_hoshu_gensen(
        input({ kubun_key: "6", bar_keieisha: mikaito }),
        tables,
      );
      assert.equal(r.ok, false, `${String(mikaito)} で結論を出している`);
      assert.equal(r.hantei, undefined);
      assert.match(r.riyu, /バー等/);
    }
  });
});

describe("判定：支払の中身", () => {
  test("どれにも当たらない支払は不要。ただし名目では決まらない旨を出す", () => {
    const r = calc_hoshu_gensen(input({ kubun_key: "gaito-nashi" }), tables);
    assert.equal(r.hantei, HANTEI.不要);
    assert.match(r.hantei_riyu, /名目/);
  });

  test("給与等・退職手当等に当たるものは「不要」ではなく「必要」", () => {
    // ★204条の対象ではないだけで、給与としての源泉徴収は要る。
    //   ここを「不要」にすると、関与先の前で徴収漏れが起きる
    const r = calc_hoshu_gensen(input({ kubun_key: "kyuyo" }), tables);
    assert.equal(r.hantei, HANTEI.必要);
    assert.equal(r.zeigaku, null);
    assert.match(r.keisan_shinai_riyu, /源泉徴収税額表|退職金/);
  });
});

describe("計算しない区分は、必要／不要をあいまいにしない", () => {
  test("3号・5号・6号・7号・8号は「必要」を返し、税額だけ返さない", () => {
    const keys = [
      ["3", {}],
      ["5", {}],
      ["6", { bar_keieisha: true }],
      ["7", {}],
      ["8", {}],
    ];
    for (const [key, over] of keys) {
      const r = calc_hoshu_gensen(input({ kubun_key: key, ...over }), tables);
      assert.equal(r.hantei, HANTEI.必要, `${key} が必要になっていない`);
      assert.notEqual(r.hantei, HANTEI.不要);
      assert.equal(r.zeigaku, null, `${key} が税額を返している`);
      assert.ok(r.keisan_shinai_riyu, `${key} に計算しない理由がない`);
    }
  });

  test("1号・2号・4号は税額を返す", () => {
    for (const key of ["1", "2-a", "2-b", "4-a", "4-b", "4-c"]) {
      const r = calc_hoshu_gensen(input({ kubun_key: key }), tables);
      assert.equal(r.hantei, HANTEI.必要);
      assert.equal(typeof r.zeigaku, "number", `${key} が税額を返していない`);
      assert.equal(r.keisan_shinai_riyu, null);
    }
  });
});

// ---------------------------------------------------------- 画面に渡す付随情報

describe("画面に渡す付随情報", () => {
  test("対象にする金額の注意は、選んだ号のものだけを返す", () => {
    const nigo = chui_for_kubun(hoshu_gensen, pick_kubun(genko_ban, "2-a"));
    const ichigo = chui_for_kubun(hoshu_gensen, pick_kubun(genko_ban, "1"));
    const hachigo = chui_for_kubun(hoshu_gensen, pick_kubun(genko_ban, "8"));

    // 登録免許税等（所基通204-11）は2号だけ
    assert.ok(nigo.some((c) => c["文"].includes("登録免許税")));
    assert.ok(!ichigo.some((c) => c["文"].includes("登録免許税")));
    // 少額の懸賞・投稿謝金（所基通204-10）は1号だけ
    assert.ok(ichigo.some((c) => c["文"].includes("懸賞")));
    assert.ok(!nigo.some((c) => c["文"].includes("懸賞")));
    // 旅費（所基通204-4）は1・2・4・5号だけ。8号には出さない
    assert.ok(!hachigo.some((c) => c["文"].includes("宿泊費")));
    // 消費税と「1回に支払うべき金額」はすべての号に出す
    for (const list of [nigo, ichigo, hachigo]) {
      assert.ok(list.some((c) => c["文"].includes("消費税")));
      assert.ok(list.some((c) => c["文"].includes("支払われるべき金額")));
      // 所基通205-1 の但書（100万円超の判定は現実の支払額でよい）を落とさない
      assert.ok(list.some((c) => c["文"].includes("ただし100万円を超えるか")));
    }
  });

  test("給与等の入力欄が要るのは、給与を差し引く控除の区分だけ", () => {
    assert.equal(needs_kyuyo_nyuryoku(pick_kubun(genko_ban, "4-b")), true);
    assert.equal(needs_kyuyo_nyuryoku(pick_kubun(genko_ban, "2-b")), false);
    assert.equal(needs_kyuyo_nyuryoku(pick_kubun(genko_ban, "1")), false);
  });

  test("版の適用期間が重なっていない（旧版の終了日を閉じ忘れると新版が使われない）", () => {
    const ban = hoshu_gensen["版"];
    for (let i = 0; i < ban.length - 1; i++) {
      assert.notEqual(
        ban[i]["適用終了日"],
        null,
        `${i} 番目の版の適用終了日が閉じていない。後ろの版に到達できなくなる`,
      );
      assert.ok(ban[i]["適用終了日"] < ban[i + 1]["適用開始日"]);
    }
    // 最後の版だけが現行（終了日なし）
    assert.equal(ban[ban.length - 1]["適用終了日"], null);
  });

  test("区分の形がそろっている（キーの欠落は過少徴収になる）", () => {
    for (const ban of hoshu_gensen["版"]) {
      for (const k of ban["区分"]) {
        if (!k["計算する"]) continue;
        assert.ok(
          ["205条1号", "205条2号"].includes(k["税率区分"]),
          `${k.key} の税率区分が知らない値`,
        );
        if (k["控除"] === null) continue;
        assert.equal(typeof k["控除"]["金額"], "number", `${k.key} の控除額が数でない`);
        assert.equal(
          typeof k["控除"]["給与を差し引く"],
          "boolean",
          `${k.key} の「給与を差し引く」が真偽値でない。欠けると控除しすぎになる`,
        );
        assert.equal(typeof k["控除"]["呼称"], "string");
      }
    }
  });

  test("区分の選択肢がそろっている（8号すべて＋給与等＋該当なし）", () => {
    const gou = new Set(
      genko_ban["区分"].filter((k) => k["号"] !== null).map((k) => k["号"]),
    );
    assert.deepEqual([...gou].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.ok(genko_ban["区分"].some((k) => k["種別"] === "給与等"));
    assert.ok(genko_ban["区分"].some((k) => k["種別"] === "該当なし"));
  });
});
