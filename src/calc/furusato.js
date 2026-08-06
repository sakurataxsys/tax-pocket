// ふるさと納税の限度額（自己負担2,000円で寄附できる額の目安）を求める。
//
// ★「限度額」という数値は法令に無い。法令が定めているのは控除額の計算で、限度額は
//   「住民税の特例控除が所得割額の20％に達する寄附額」を逆算したものである。
//   だから画面には「自己負担が2,000円ちょうどで収まる額」とは書かない（下の★を参照）。
//
// 根拠条文（URL は data/furusato.json の「出典」に記載）
//   地方税法 37条の2第1項・314条の7第1項      基本控除（10％）と寄附金額の30％の上限
//   地方税法 37条の2第11項・314条の7第11項    特例控除（割合表・20％の上限・1号〜3号）
//   地方税法附則 5条の5                        2号・3号等に該当する場合の割合（最も低い割合）
//   地方税法附則 5条の6                        割合の読替え（84.895％ ほか）
//   地方税法附則 34条2項・3項4号               長期譲渡所得の金額（特別控除前）と読替え
//   所得税法 78条1項1号                        寄附金控除（40％の上限）
//
// 金額・割合はこのファイルに書かない。すべて data/*.json から受け取る（設計原則3）。

import { pick_version } from "./version_pick.js";
import { calc_shotokuzei_engine } from "./shotokuzei.js";

/** 上限つきの区分表から、値が収まる行を取り出す。上限 null は「上限なし」。 */
function find_row(table, value, key) {
  return table.find((r) => r[key] === null || value <= r[key]);
}

/** 割合表（地方税法37条の2第11項1号・附則5条の6で読替え後）を引く。 */
function wariai_from_table(kingaku, tokurei) {
  return find_row(tokurei["割合表"], kingaku, "課税総所得の上限")["割合パーセント"];
}

/**
 * 特例控除額の計算に使う割合を決める。地方税法37条の2第11項・附則5条の5。
 *
 * ★号の対応（原文で確認済み。取り違えやすい）
 *   1号 課税総所得金額を有し、そこから人的控除差調整額を控除した金額が【零以上】 → 割合表
 *   2号 課税総所得金額を有し、控除した金額が【零を下回り】、課税山林・課税退職を有しない → 90％
 *   3号 控除した金額が零を下回る又は課税総所得金額を有しない場合で、課税山林又は課税退職を有する
 *   附則5条の5 2号・3号に該当する場合、または課税総所得・課税退職・課税山林をいずれも有しない
 *              場合であって、分離課税（附則33条の2・34・35・35条の2・35条の2の2 ほか）の適用を
 *              受けるとき → それぞれの割合のうち【最も低い割合】
 *
 * ★2号の90％には附則5条の6の読替えが及ばない（1.021を掛けない）。読み替えられるのは
 *   1号の表と附則5条の5第1項3号〜5号だけである。
 *
 * ★このツールのエンジンは住民税の課税山林所得金額・課税退職所得金額を常に0で返すため、
 *   3号は成立しない（住民税の退職所得は現年分離課税で、翌年度分の所得割に入らない）。
 *
 * 課税総所得金額も分離課税の所得も無いときは、どの号にも該当しない（2号は「課税総所得金額を
 * 有する場合」が要件）。このとき割合は決まらないので null を返す。「3号の90％」と表示しない。
 */
export function pick_wariai(kazei_sogo, sashihiki, bunri_kubun_list, tokurei) {
  if (kazei_sogo > 0 && sashihiki >= 0) {
    return {
      wariai_percent: wariai_from_table(sashihiki, tokurei),
      konkyo: "地方税法37条の2第11項1号",
    };
  }

  // 2号・3号に該当する場合、または課税総所得等をいずれも有しない場合で、分離課税があるとき
  const rows = tokurei["附則5条の5の割合"].filter((r) =>
    bunri_kubun_list.includes(r["kubun"]),
  );
  if (rows.length > 0) {
    const hikui = rows.reduce((a, b) =>
      b["割合パーセント"] < a["割合パーセント"] ? b : a,
    );
    return {
      wariai_percent: hikui["割合パーセント"],
      konkyo: "地方税法附則5条の5第1項",
      kubun: hikui["kubun"],
    };
  }

  if (kazei_sogo > 0) {
    return {
      wariai_percent: tokurei["課税総所得を有し差引が負の場合の割合パーセント"],
      konkyo: "地方税法37条の2第11項2号",
    };
  }

  return { wariai_percent: null, konkyo: null };
}

/**
 * 特例控除の20％の上限から、寄附額を逆算する（限度額A）。
 *
 * 特例控除額 ＝（寄附額 − 自己負担額）× 割合 で、これが所得割額の20％を超えると頭打ちになる。
 * 頭打ちになる寄附額 ＝ 所得割額 × 20％ ÷ 割合 ＋ 自己負担額。
 *
 * ★令和9年分の寄附からは、20％と総額上限（合計193万円）のいずれか低い金額が頭になる
 *   （37条の2第11項ただし書・314条の7第11項ただし書）。データが null のときは20％だけ。
 *
 * 端数処理はここでは行わない（円未満の小数のまま返す）。表示上の丸めは calc_furusato で行う。
 */
export function calc_joge_a(shotokuwari_gokei, wariai_percent, tokurei, jiko_futan) {
  const nijupa =
    (shotokuwari_gokei * tokurei["所得割額に対する上限率パーセント"]) / 100;
  const sogaku_joge = tokurei["特例控除額の総額上限"];
  const bunshi =
    sogaku_joge === null || sogaku_joge === undefined
      ? nijupa
      : Math.min(nijupa, sogaku_joge);
  return bunshi / (wariai_percent / 100) + jiko_futan;
}

/**
 * 3つの控除の内訳を出す。限度額まで寄附したものとして計算する。
 *
 * ★合計が「寄附額 − 自己負担額」に一致しないことがある。
 *   所得税の限界税率 × 1.021 ＋ 10％ ＋ 割合 が 100％になるのは、正式方式の割合の区分と
 *   所得税の税率の区分が一致するときだけで、生命保険料控除・地震保険料控除・ふるさと納税以外の
 *   寄附金控除があると引き値がずれて区分が分かれることがある（判断ログ D-29）。
 *   一致しないときは、どの寄附額でも自己負担が2,000円ちょうどにはならない。
 */
function calc_uchiwake(gendo_gaku, wariai_percent, genkai_zeiritsu, fukko_joritsu, kihon_ritsu, jiko_futan) {
  const taisho = Math.max(gendo_gaku - jiko_futan, 0);
  const shotokuzei = (taisho * genkai_zeiritsu * fukko_joritsu) / 100;
  const juminzei_kihon = (taisho * kihon_ritsu) / 100;
  const juminzei_tokurei = (taisho * wariai_percent) / 100;
  const gokei = shotokuzei + juminzei_kihon + juminzei_tokurei;
  return {
    taisho,
    shotokuzei,
    juminzei_kihon,
    juminzei_tokurei,
    gokei,
    // 円未満の丸め誤差を拾わないよう1円の幅を持たせる
    jiko_futan_ni_osamaru: Math.abs(gokei - taisho) < 1,
  };
}

/** 表示上の丸め。1,000円未満切捨て（法令の端数規定ではなく、このツールの判断）。 */
function floor_sen(gaku) {
  return Math.floor(gaku / 1000) * 1000;
}

/**
 * ふるさと納税の限度額を計算する。
 * tables: { shotokuzei, juminzei, bunri_kazei, income_tax, furusato }
 */
export function calc_furusato(input, tables) {
  const fv = pick_version(tables.furusato["版"], input.nen);
  if (!fv) {
    return { ok: false, riyu: `${input.nen}年分の寄附は収録していません。` };
  }

  const engine = calc_shotokuzei_engine(input, tables);
  if (!engine.ok) return { ok: false, riyu: engine.riyu };

  const rv = pick_version(tables.income_tax["版"], input.nen);
  const tokurei = fv["特例控除"];
  const kihon = fv["基本控除"];
  const jiko_futan = fv["自己負担額"];
  // 復興特別所得税の乗率は income_tax_rates.json から導く（同じ数値を2箇所に持たない）
  const fukko_joritsu = 1 + rv["復興特別所得税率パーセント"] / 100;
  const genkai_zeiritsu = engine.shotokuzei.genkai_zeiritsu_percent;

  const chui = [...engine.chui];

  // ── 寄附金額そのものに掛かる2つの上限 ──
  //
  // ★分母はいずれも「特別控除前」の合計所得金額。地方税法附則34条2項が長期譲渡所得の金額を
  //   特別控除をしないで計算した金額と定義し、同条3項4号が37条の2第1項の「山林所得金額」を
  //   これを含むものに読み替える（所得税側も措置法31条3項3号が同じ読替えをする）。
  const joge_b =
    (engine.gokei_shotoku_kingaku_juminzei * kihon["寄附金額の上限の率パーセント"]) / 100;

  // ★40％の上限は「特定寄附金の額の合計額」に働く（所法78条1項1号）ので、ふるさと納税以外の
  //   寄附がある場合は枠を分け合う。入力は【控除額】（＝支出額 − 2,000円）なので支出額に戻す。
  const hoka_kifukin_kojo = input.butsuteki["kifukin_kojo"] ?? 0;
  const hoka_kifukin_gaku =
    hoka_kifukin_kojo > 0 ? hoka_kifukin_kojo + jiko_futan : 0;
  const joge_c = Math.max(
    (engine.gokei_shotoku_kingaku * fv["所得税の寄附金控除"]["寄附金額の上限の率パーセント"]) /
      100 -
      hoka_kifukin_gaku,
    0,
  );
  if (hoka_kifukin_gaku > 0) {
    chui.push(
      "ふるさと納税のほかに寄附金控除があります。所得税の40％の上限は寄附金の合計額に働くため、" +
        "その分を差し引いています。住民税の30％の上限はほかの寄附金の入力を持たないため、" +
        "差し引いていません。",
    );
  }

  const shotokuwari = engine.juminzei.shotokuwari.gokei;
  const bunri_kubun_list = (input.bunri ?? [])
    .filter((b) => b["kazei_hyojun"] > 0 || b["shotoku_kingaku"] > 0)
    .map((b) => b["kubun"]);

  /** 割合を1つ決めて、そこから限度額と内訳を組み立てる */
  function build(wariai) {
    if (wariai.wariai_percent === null || shotokuwari <= 0) {
      return {
        hikizuru_gaku: wariai.hikizuru_gaku,
        wariai_percent: wariai.wariai_percent,
        wariai_konkyo: wariai.konkyo,
        gendo_gaku: 0,
        gendo_gaku_riron: 0,
        kimete: null,
        joge: { A: 0, B: joge_b, C: joge_c },
        uchiwake: null,
      };
    }
    const a = calc_joge_a(shotokuwari, wariai.wariai_percent, tokurei, jiko_futan);
    const riron = Math.min(a, joge_b, joge_c);
    const kimete = riron === a ? "A" : riron === joge_b ? "B" : "C";
    const gendo = floor_sen(riron);
    return {
      hikizuru_gaku: wariai.hikizuru_gaku,
      wariai_percent: wariai.wariai_percent,
      wariai_konkyo: wariai.konkyo,
      gendo_gaku: gendo,
      gendo_gaku_riron: riron,
      kimete,
      joge: { A: a, B: joge_b, C: joge_c },
      uchiwake: calc_uchiwake(
        gendo,
        wariai.wariai_percent,
        genkai_zeiritsu,
        fukko_joritsu,
        kihon["率パーセント"],
        jiko_futan,
      ),
    };
  }

  // ── 正式方式（地方税法37条の2第11項）──
  const kazei_sogo_juminzei = engine.juminzei.kazei_sogo_shotoku_kingaku;
  const sashihiki = engine.juminzei.kazei_sogo_minus_jinteki_sa;
  const seishiki = build({
    ...pick_wariai(kazei_sogo_juminzei, sashihiki, bunri_kubun_list, tokurei),
    hikizuru_gaku: sashihiki,
  });

  // ── 簡易方式（民間の近似。法令の方式ではない）──
  //
  // ★正式方式の引き値は、式を展開すると
  //     住民税の課税総所得金額 − 人的控除差調整額 ＝ 所得税の課税総所得金額
  //                                                 ＋（所得税の物的控除 − 住民税の物的控除）
  //   になる（住民税の基礎控除43万円＋人的控除差の基礎額5万円が、所得税の基礎控除の基準額48万円と
  //   ちょうど相殺されるため）。つまり両方式の差は【生命保険料控除・地震保険料控除・ふるさと納税
  //   以外の寄附金控除の所得税と住民税の差】だけで、それらが無ければ両方式は一致する。
  //   物的控除は住民税のほうが小さいので、正式方式の引き値は簡易方式以上になり、
  //   割合は同じか小さく、限度額は同じか大きく出る。
  const kazei_sogo_shotokuzei = engine.shotokuzei.kazei_sogo_shotoku_kingaku;
  const kani = build({
    wariai_percent: wariai_from_table(kazei_sogo_shotokuzei, tokurei),
    konkyo: "民間の近似（所得税の課税総所得金額で割合表を引く）",
    hikizuru_gaku: kazei_sogo_shotokuzei,
  });

  if (seishiki.uchiwake && !seishiki.uchiwake.jiko_futan_ni_osamaru) {
    chui.push(
      "正式方式の割合の区分と所得税の税率の区分が分かれているため、自己負担は2,000円ちょうどには" +
        "なりません（生命保険料控除・地震保険料控除・ほかの寄附金控除があるときに起こります）。",
    );
  }
  chui.push(
    "限度額まで寄附したときの所得税の軽減額は、寄附による所得控除で課税所得の区分が下がる場合の" +
      "税率の変化までは追っていません。",
  );

  return {
    ok: true,
    tekiyo_nenbun_hyoji: fv["適用年分表示"],
    juminzei_nendo_hyoji: engine.juminzei_nendo_hyoji,
    kojo_nashi: shotokuwari <= 0 || seishiki.wariai_percent === null,
    jiko_futan,
    seishiki,
    kani,
    sagaku: seishiki.gendo_gaku - kani.gendo_gaku,
    engine,
    chui,
  };
}
