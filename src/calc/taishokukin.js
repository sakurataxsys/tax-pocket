// 退職所得の計算
//
// 根拠条文（原文は data/*.json の「出典」に URL を記載）
//   所得税法 30条        退職所得の金額・退職所得控除額・短期退職手当等・特定役員退職手当等
//   所得税法 89条        税率
//   所得税法 201条       源泉徴収すべき税額（1項＝申告書の提出あり／3項＝提出なし）
//   所得税法施行令 69条  勤続年数の計算（1年未満の端数）
//   所得税法施行令 71条  障害による退職の要件
//   復興財源確保法 13条・28条  復興特別所得税
//   地方税法 328条の3・50条の4 分離課税に係る所得割の税率
//
// 金額・税率はこのファイルに書かない。すべて data/*.json から受け取る（設計原則3）。

import { pick_version } from "./version_pick.js";

/**
 * 勤続年数を求める。
 * 所令69条2項「一年未満の端数を生じたときは、これを一年として」＝ 1年未満は切上げ。
 */
export function calc_kinzoku_nensu(years, months) {
  return years + (months > 0 ? 1 : 0);
}

/**
 * 退職所得控除額を求める。所法30条3項・6項2号・6項3号。
 * 6項3号は「80万円の下限を適用したうえで100万円を加算する」と読める書き方になっているため、
 * 下限 → 障害加算 の順に適用する。
 */
export function calc_taishoku_shotoku_kojo(kinzoku_nensu, is_shogai, kojo_table) {
  const kijun_nensu = kojo_table["基礎額に達する勤続年数"];
  let kojo;
  if (kinzoku_nensu <= kijun_nensu) {
    kojo = kojo_table["勤続20年以下の1年あたりの金額"] * kinzoku_nensu;
  } else {
    kojo =
      kojo_table["勤続20年超の基礎額"] +
      kojo_table["勤続20年超の1年あたりの金額"] * (kinzoku_nensu - kijun_nensu);
  }
  // 所法30条6項2号：80万円に満たない場合は80万円
  kojo = Math.max(kojo, kojo_table["最低額"]);
  // 所法30条6項3号：障害者になったことに直接基因する退職は100万円を加算
  if (is_shogai) kojo += kojo_table["障害退職の加算額"];
  return kojo;
}

/**
 * 退職手当等の区分を判定する。
 * 所法30条4項（短期退職手当等）・5項（特定役員退職手当等）。
 *
 * 一般勤続期間と役員等勤続期間が混在する場合の按分（所令71条の2第13項）は第1版のスコープ外。
 * その場合は kubun を null にして riyu を返す。
 */
export function judge_kubun(kinzoku_nensu, yakuin_kinzoku_nensu, tanki_setting) {
  if (yakuin_kinzoku_nensu > 0 && yakuin_kinzoku_nensu <= 5) {
    if (yakuin_kinzoku_nensu < kinzoku_nensu) {
      return {
        kubun: null,
        riyu:
          "役員等としての期間とそれ以外の期間が混在しています。" +
          "この場合の按分計算（所得税法施行令71条の2第13項）はこのツールでは扱いません。",
      };
    }
    return { kubun: "特定役員退職手当等", riyu: null };
  }
  if (
    yakuin_kinzoku_nensu === 0 &&
    kinzoku_nensu <= 5 &&
    tanki_setting["適用する"]
  ) {
    return { kubun: "短期退職手当等", riyu: null };
  }
  return { kubun: "一般退職手当等", riyu: null };
}

/**
 * 退職所得の金額（課税退職所得金額）を求める。所法30条2項。
 * 千円未満切捨て（所法201条1項イ・ロ・ハ）。
 */
export function calc_kazei_taishoku_shotoku(kubun, shunyu, kojo, tanki_setting) {
  const zangaku = Math.max(shunyu - kojo, 0);
  let kingaku;
  if (kubun === "特定役員退職手当等") {
    // 2分の1を乗じない
    kingaku = zangaku;
  } else if (kubun === "短期退職手当等") {
    const joge = tanki_setting["2分の1が適用される残額の上限"];
    if (zangaku <= joge) {
      kingaku = zangaku / 2;
    } else {
      // 150万円 ＋（収入金額 −（300万円 ＋ 退職所得控除額））
      kingaku = tanki_setting["上限を超える場合の定額部分"] + (zangaku - joge);
    }
  } else {
    kingaku = zangaku / 2;
  }
  // 千円未満切捨て
  return Math.floor(kingaku / 1000) * 1000;
}

/** 復興特別所得税を含めた乗率の分子（分母は1000）。例：2.1% → 1021 */
function fukko_bunshi(fukko_ritsu_percent) {
  return Math.round((100 + fukko_ritsu_percent) * 10);
}

/**
 * 源泉徴収すべき所得税及び復興特別所得税を求める。
 * 申告書の提出あり：所法201条1項（速算表）／提出なし：所法201条3項（収入金額×20%）
 * いずれも復興特別所得税2.1%を加算し、1円未満切捨て（国税庁 速算表の注記）。
 */
export function calc_shotokuzei(kazei_gaku, shunyu, is_teishutsu, rate_version) {
  const bunshi = fukko_bunshi(rate_version["復興特別所得税率パーセント"]);

  if (!is_teishutsu) {
    // 所法201条3項：退職手当等の金額に20%を乗じた金額（＋復興特別所得税で20.42%）
    const ritsu = rate_version["受給申告書が未提出の場合の所得税率パーセント"];
    return Math.floor((shunyu * ritsu * bunshi) / (100 * 1000));
  }

  const gyo = rate_version["速算表"].find(
    (r) =>
      r["課税退職所得金額の上限"] === null ||
      kazei_gaku <= r["課税退職所得金額の上限"],
  );
  const shotokuzei_only = (kazei_gaku * gyo["税率パーセント"]) / 100 - gyo["控除額"];
  if (shotokuzei_only <= 0) return 0;
  // 1円未満切捨て
  return Math.floor((shotokuzei_only * bunshi) / 1000);
}

/**
 * 住民税（分離課税に係る所得割）を求める。
 * 市町村民税6%・道府県民税4%を、それぞれ100円未満切捨て（総務省の計算手順）。
 * 平成25年1月1日以降、従前の10%税額控除は廃止されている。
 */
export function calc_juminzei(kazei_gaku, juminzei_setting) {
  const kiritsute = (gaku) => Math.floor(gaku / 100) * 100;
  const shichoson = kiritsute(
    (kazei_gaku * juminzei_setting["市町村民税の税率パーセント"]) / 100,
  );
  const dofuken = kiritsute(
    (kazei_gaku * juminzei_setting["道府県民税の税率パーセント"]) / 100,
  );
  return { shichoson, dofuken, gokei: shichoson + dofuken };
}

/**
 * 退職金の手取りまでを一括で計算する。
 *
 * input: {
 *   shunyu: 退職金の額（円）
 *   kinzoku_years, kinzoku_months: 勤続期間
 *   yakuin_kinzoku_nensu: 役員等勤続年数（0＝役員等でない）
 *   is_shogai: 障害による退職か
 *   is_teishutsu: 退職所得の受給に関する申告書を提出しているか
 *   nen: 適用年分（西暦）
 * }
 * tables: { taishokukin: <taishokukin.json>, income_tax: <income_tax_rates.json> }
 */
export function calc_taishokukin(input, tables) {
  const version = pick_version(tables.taishokukin["版"], input.nen);
  const rate_version = pick_version(tables.income_tax["版"], input.nen);
  if (!version || !rate_version) {
    return { ok: false, riyu: `${input.nen}年分のデータが収録されていません。` };
  }

  const kinzoku_nensu = calc_kinzoku_nensu(
    input.kinzoku_years,
    input.kinzoku_months,
  );
  if (kinzoku_nensu < 1) {
    return { ok: false, riyu: "勤続年数を1年以上で入力してください。" };
  }
  if (input.yakuin_kinzoku_nensu > kinzoku_nensu) {
    return {
      ok: false,
      riyu: "役員等勤続年数が勤続年数を超えています。入力を確認してください。",
    };
  }

  const { kubun, riyu } = judge_kubun(
    kinzoku_nensu,
    input.yakuin_kinzoku_nensu,
    version["短期退職手当等"],
  );
  if (kubun === null) return { ok: false, riyu };

  const kojo = calc_taishoku_shotoku_kojo(
    kinzoku_nensu,
    input.is_shogai,
    version["退職所得控除"],
  );
  const zangaku = Math.max(input.shunyu - kojo, 0);
  const kazei_gaku = calc_kazei_taishoku_shotoku(
    kubun,
    input.shunyu,
    kojo,
    version["短期退職手当等"],
  );
  const shotokuzei = calc_shotokuzei(
    kazei_gaku,
    input.shunyu,
    input.is_teishutsu,
    rate_version,
  );
  const juminzei = calc_juminzei(kazei_gaku, version["住民税"]);

  return {
    ok: true,
    kubun,
    tekiyo_nenbun_hyoji: version["適用年分表示"],
    kinzoku_nensu,
    kojo,
    zangaku,
    kazei_gaku,
    hanbun_tekiyo: kubun !== "特定役員退職手当等",
    is_teishutsu: input.is_teishutsu,
    shotokuzei,
    juminzei,
    tegaki: input.shunyu - shotokuzei - juminzei.gokei,
  };
}
