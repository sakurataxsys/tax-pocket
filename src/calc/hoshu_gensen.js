// 報酬・料金等に対する源泉徴収の判定と税額
//
// 根拠条文（原文と出典URLは data/hoshu_gensen.json の「出典」）
//   所得税法 204条1項     源泉徴収義務（対象は1号〜8号の限定列挙）
//   所得税法 204条2項     適用しない場合（1号＝給与等・退職手当等／2号＝給与を払わない個人／3号＝6号の例外）
//   所得税法 205条        徴収税額（1号＝10%・100万円超は20%／2号＝控除後10%）
//   所得税法施行令 320条  1号・2号・4号・5号・7号・8号の範囲
//   所得税法施行令 322条  支払金額から控除する金額
//   復興財確法 28条       復興特別所得税（所得税額の2.1%・令和19年12月31日まで）
//   復興財確法 31条2項    端数（★所得税と復興特別所得税の「合計額」で1円未満切捨て）
//   所基通 204-1          支払先が法人以外の団体等である場合
//   所基通 204-5          給与につき源泉徴収義務のある個人の意義
//
// ★この画面の主役は税額ではなく「源泉徴収が必要な範囲の区別」である。
//   判定の結果は必ず「必要」「不要」「判定できません」の3値のどれかを返し、
//   税額を計算しない場合でも、必要／不要をあいまいにしない。
//   「計算しない」を「不要」と読み違えると、関与先の前で徴収漏れが起きる。
//
// ★端数の取り方に注意（復興財確法31条2項）。
//   所得税を先に1円未満切り捨ててから2.1%を掛けると、合計額で切り捨てた場合と1円ずれる。
//   例：33,333円 → 合計で切捨て 3,403円／所得税を先に切捨て 3,402円。
//   条文は「これらの確定金額の合計額によって行い」と定めるので、掛けてから1回だけ切り捨てる。
//
// 金額・税率・条文・画面の文言はこのファイルに書かない。すべて data/*.json から受け取る（設計原則3）。

import { pick_version } from "./version_pick.js";

/** 判定の3値。画面の見出しはこのどれかになる */
export const HANTEI = {
  必要: "必要",
  不要: "不要",
  判定不可: "判定できません",
};

/**
 * 支払日に対応する版を取り出す。
 *
 * 日付は ISO 文字列（"YYYY-MM-DD"）の辞書順で比べる。
 * new Date("2038-01-01") は UTC の午前0時に解釈され、日本時間では前日になるため使わない
 * （印紙税の judge_keigen と同じ作法）。
 */
export function pick_hoshu_version(versions, shiharai_bi) {
  return (
    versions.find(
      (v) =>
        shiharai_bi >= v["適用開始日"] &&
        (v["適用終了日"] === null || shiharai_bi <= v["適用終了日"]),
    ) ?? null
  );
}

/** 画面の選択肢（号だけでは引けない。2号・4号は控除の有無で分かれる） */
export function pick_kubun(version, key) {
  return version["区分"].find((k) => k.key === key) ?? null;
}

/** 選んだ区分に出す「対象にする金額」の注意だけを取り出す */
export function chui_for_kubun(hoshu_gensen, kubun) {
  if (kubun === null || kubun["号"] === null) return [];
  return hoshu_gensen["対象金額の注意"].filter((c) =>
    c["対象の号"].includes(kubun["号"]),
  );
}

/** 選んだ区分に、その月中の給与等の入力欄が要るか */
export function needs_kyuyo_nyuryoku(kubun) {
  return kubun !== null && kubun["控除"] !== null && kubun["控除"]["給与を差し引く"];
}

/**
 * 復興特別所得税を含めた乗率の分子（分母は1000）。例：2.1% → 1021
 *
 * ★Number() を通すのは、JSONの値が文字列 "2.1" になっていたときに
 *   (100 + "2.1") が文字列連結の "1002.1" になり、税額が10倍で出るため。
 *   例外にならず、もっともらしい数字が画面に出てしまう経路なので、入口で潰す。
 */
function fukko_bunshi(fukko_ritsu_percent) {
  return Math.round((100 + Number(fukko_ritsu_percent)) * 10);
}

/**
 * 差し引く金額（所令322条）を求める。
 * 「給与を差し引く」区分は、控除額からその月中の給与等の額を引く。引いて負になったら0。
 */
export function calc_kojo(kubun, kyuyo_gaku) {
  const kojo = kubun["控除"];
  if (kojo === null) return 0;
  if (!kojo["給与を差し引く"]) return kojo["金額"];
  return Math.max(0, kojo["金額"] - kyuyo_gaku);
}

/**
 * 源泉徴収すべき所得税及び復興特別所得税の額を求める。
 *
 * 205条1号：支払金額×10%（100万円を超える部分は20%）
 * 205条2号：控除後の残額×10%
 * いずれも復興特別所得税2.1%を上乗せし、**合計額で1円未満切捨て**（復興財確法31条2項）。
 *
 * 掛け算はすべて整数のまま行う。所得税額を先に小数で出すと、
 * 2.1%を掛けたあとの1円未満の判定が浮動小数の誤差で揺れる。
 */
export function calc_zeigaku(kingaku, kubun, zeiritsu, fukko_ritsu_percent, kyuyo_gaku) {
  const bunshi = fukko_bunshi(fukko_ritsu_percent);
  const kihon = zeiritsu["基本パーセント"];
  let kekka;

  if (kubun["税率区分"] === "205条1号") {
    const kugiri = zeiritsu["区切り金額"];
    const chouka = zeiritsu["超過パーセント"];
    // 所得税額を100倍した整数（「金額×税率パーセント」のまま持つ）
    const shotoku_x100 =
      kingaku <= kugiri
        ? kingaku * kihon
        : kugiri * kihon + (kingaku - kugiri) * chouka;
    kekka = {
      zeigaku: Math.floor((shotoku_x100 * bunshi) / (100 * 1000)),
      kojo: 0,
      zangaku: kingaku,
      chouka_ari: kingaku > kugiri,
    };
  } else if (kubun["税率区分"] === "205条2号") {
    // ★控除の形が崩れていたら計算しない。
    //   「給与を差し引く」が欠けると、差し引かずに控除しすぎた税額（過少徴収）が黙って出る
    const setting = kubun["控除"];
    if (
      setting === null ||
      typeof setting["金額"] !== "number" ||
      typeof setting["給与を差し引く"] !== "boolean"
    ) {
      return null;
    }
    // 205条2号：控除した残額に10%（100万円超の割増しは無い）
    const kojo = calc_kojo(kubun, kyuyo_gaku);
    const zangaku = Math.max(0, kingaku - kojo);
    kekka = {
      zeigaku: Math.floor((zangaku * kihon * bunshi) / (100 * 1000)),
      kojo,
      zangaku,
      chouka_ari: false,
    };
  } else {
    // ★知らない税率区分は計算しない。
    //   以前はここが「205条1号でなければ2号」だったため、data の文字が1字違っただけで
    //   100万円超の割増し（205条1号かっこ書き）が黙って消え、過少徴収になっていた
    return null;
  }

  // ★数にならない値が混じったら計算しない。
  //   data のキーが欠けると NaN のまま「NaN円」と画面に出るため、ここで止める
  if (!Number.isFinite(kekka.zeigaku) || kekka.zeigaku < 0) return null;
  return kekka;
}

/**
 * 源泉徴収が必要かどうかを判定する。税額は求めない。
 *
 * 止まる経路が3種類あるため、返り値は必ず hantei を持つ。
 * 「税額を出さない」ことと「源泉徴収が不要」であることを、呼び出し側が取り違えないようにする。
 */
export function judge_hitsuyo(input, hoshu_gensen, version) {
  const hantei_setting = hoshu_gensen["判定"];

  const saki = hantei_setting["支払先"].find((s) => s.key === input.shiharaisaki);
  if (!saki) return null;

  // 支払先が非居住者・外国法人なら、支払の中身によらずこの画面の外（所法212条）
  if (saki["結論"] === "判定できません") {
    return {
      hantei: HANTEI.判定不可,
      riyu: saki["説明"],
      konkyo: saki["根拠"],
    };
  }

  // ------------------------------------------------------------ 支払の中身
  // ★支払先より先に区分を見る。法人への支払は原則不要だが、8号（馬主が受ける競馬の賞金）
  //   だけは内国法人でも必要になるため、区分を知らないと「不要」と言い切れない
  const kubun = pick_kubun(version, input.kubun_key);
  if (!kubun) return null;

  if (saki["結論"] === "不要") {
    if (kubun["号"] === 8) {
      // 8号は「広告宣伝の賞金」と「馬主が受ける競馬の賞金」の2つを含む。
      // 前者は法人への支払なら不要、後者は必要（所法174条10号・212条3項）
      return {
        hantei: HANTEI.判定不可,
        riyu: saki["8号の説明"],
        konkyo: saki["8号の根拠"],
        kubun,
      };
    }
    return {
      hantei: HANTEI.不要,
      riyu: saki["説明"],
      konkyo: saki["根拠"],
      kubun,
    };
  }

  if (kubun["種別"] === "該当なし") {
    return {
      hantei: HANTEI.不要,
      riyu:
        "所得税法204条1項に挙げられた1号から8号までのどれにも当たらない支払は、" +
        "源泉徴収の対象になりません。ただし名目では決まりません。" +
        "謝礼・車賃・記念品代などの名義でも、実質が報酬・料金なら対象です（所基通204-2）。",
      konkyo: kubun["根拠"],
    };
  }

  if (kubun["種別"] === "給与等") {
    // ★「不要」ではない。204条の対象ではないというだけで、給与としての源泉徴収は要る
    return {
      hantei: HANTEI.必要,
      riyu: kubun["計算しない理由"],
      konkyo: kubun["根拠"],
      kubun,
    };
  }

  // ------------------------------------------------------------ 支払者
  const sha = hantei_setting["支払者"].find((s) => s.key === input.shiharaisha);
  if (!sha) return null;

  if (sha["結論"] === "6号以外は不要" && kubun["号"] !== 6) {
    return {
      hantei: HANTEI.不要,
      riyu: sha["説明"],
      konkyo: sha["根拠"],
      kubun,
    };
  }

  // ------------------------------------------------- 6号だけの例外（204条2項3号）
  //
  // ★未回答を「不要」に落とさない。
  //   ここを既定値なしのチェック欄で受けていたため、6号を選んだだけで（質問に答える前に）
  //   見出しが「源泉徴収は不要です」に変わっていた。答えが「経営者以外」と確定するまでは、
  //   結論を出さずに呼び出し側へ「未回答」を返す
  if (kubun["号"] === 6) {
    const bar = hantei_setting["バー等の経営者"];
    if (input.bar_keieisha !== true && input.bar_keieisha !== false) {
      return { michaito: bar["未回答の案内"], kubun };
    }
    if (input.bar_keieisha === false) {
      return {
        hantei: HANTEI.不要,
        riyu: bar["経営者以外の説明"],
        konkyo: bar["根拠"],
        kubun,
      };
    }
  }

  return {
    hantei: HANTEI.必要,
    riyu: saki["説明"], // 法人格のない団体を選んだときだけ本文が入る
    konkyo: kubun["根拠"],
    kubun,
  };
}

/**
 * 判定と税額をまとめて求める。
 *
 * input: {
 *   shiharai_bi:   支払日（"YYYY-MM-DD"）
 *   shiharaisaki:  支払先の key（"kojin" "hojin" "dantai" "hikyojusha"）
 *   shiharaisha:   支払者の key（"kojin-igai" "kyuyo-ari" "kyuyo-nashi"）
 *   kubun_key:     支払の中身の key（"1" "2-a" "2-b" … "gaito-nashi"）
 *   bar_keieisha:  支払者がバー等の経営者か（6号のときだけ見る）
 *   kingaku:       源泉徴収の対象にする金額（円）
 *   kyuyo_gaku:    その月中に支払う給与等の額（円。控除に給与を差し引く区分のときだけ見る）
 * }
 * tables: { hoshu_gensen: <hoshu_gensen.json>, income_tax_rates: <income_tax_rates.json> }
 */
export function calc_hoshu_gensen(input, tables) {
  const { hoshu_gensen, income_tax_rates } = tables;

  // 日付が空のときは、収録開始日より前として弾かれて誤った案内が出るので先に見る
  if (!input.shiharai_bi) {
    return { ok: false, riyu: "支払う年月日を入れてください。" };
  }

  // 収録範囲より前は計算しない。復興特別所得税が無い時代の税率は10%・20%そのもので、
  // 黙って現行の10.21%を出すと、もっともらしい誤った税額になる
  if (input.shiharai_bi < hoshu_gensen["収録開始日"]) {
    return {
      ok: false,
      riyu:
        "平成25年1月1日より前の支払は、この画面では扱いません。" +
        "当時は復興特別所得税がなく、税率が異なります。",
    };
  }

  const version = pick_hoshu_version(hoshu_gensen["版"], input.shiharai_bi);
  if (version === null) {
    return {
      ok: false,
      riyu:
        "この支払日に対応する区分表が入っていません。" +
        "アプリをいったん閉じて開き直し、それでも出るときは事務所へ知らせてください。",
    };
  }

  const hantei = judge_hitsuyo(input, hoshu_gensen, version);
  if (hantei === null) {
    return { ok: false, riyu: "支払先・支払者・支払の中身を選んでください。" };
  }
  // 判定に必要な答えがまだ揃っていない。★結論を出さずに、聞くべきことだけを返す
  if (hantei.michaito) {
    return { ok: false, riyu: hantei.michaito };
  }

  const kubun = hantei.kubun ?? null;
  const base = {
    ok: true,
    hantei: hantei.hantei,
    hantei_riyu: hantei.riyu,
    konkyo: hantei.konkyo,
    kubun,
    chui: chui_for_kubun(hoshu_gensen, kubun),
    zeigaku: null,
    keisan: null,
    keisan_shinai_riyu: null,
  };

  // 「必要」でなければ税額は出さない
  if (hantei.hantei !== HANTEI.必要) return base;

  // 「必要」でも、この画面で計算しない区分がある。★不要ではないことを呼び出し側に残す
  if (kubun === null || !kubun["計算する"]) {
    return {
      ...base,
      keisan_shinai_riyu:
        kubun?.["計算しない理由"] ??
        "この区分の税額は、この画面では計算しません。事務所で確認してください。",
    };
  }

  // 復興特別所得税の乗率は income_tax_rates.json から取る。
  // 同じ数値を2か所に置くと、復興特別所得税が終わったときに片方だけ直す事故が起きる
  const nen = Number(input.shiharai_bi.slice(0, 4));
  const rate_version = pick_version(income_tax_rates["版"], nen);
  if (rate_version === null) {
    return {
      ...base,
      keisan_shinai_riyu:
        "この支払日に対応する税率表が入っていません。" +
        "復興特別所得税の期間が終わっている可能性があります。事務所で確認してください。",
    };
  }

  const kingaku = input.kingaku ?? 0;
  const kyuyo_gaku = input.kyuyo_gaku ?? 0;
  const keisan = calc_zeigaku(
    kingaku,
    kubun,
    version["税率"],
    rate_version["復興特別所得税率パーセント"],
    kyuyo_gaku,
  );

  // ★税額が組み立てられなかった＝区分表が壊れている。もっともらしい数字を出さずに止める
  if (keisan === null) {
    return {
      ...base,
      keisan_shinai_riyu:
        "税額を計算できませんでした。区分表が新しくなっている可能性があります。" +
        "源泉徴収は必要です。金額は事務所で確認してください。",
    };
  }

  return {
    ...base,
    zeigaku: keisan.zeigaku,
    keisan: {
      ...keisan,
      kingaku,
      kyuyo_gaku,
      zeiritsu: version["税率"],
      fukko_ritsu_percent: rate_version["復興特別所得税率パーセント"],
    },
  };
}
