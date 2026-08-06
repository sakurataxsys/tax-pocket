// 所得税エンジン（課税所得金額・所得税額・住民税所得割額の計算）
//
// ★このモジュールはメニューに出さない。次に作るふるさと納税シミュレーターの土台。
//   ふるさと納税の限度額は住民税所得割額を基礎に決まるため、課税所得の計算が丸ごと必要になる
//   （docs/仕様.md §4）。
//
// ★所得税ベースと住民税ベースの2系統を同時に返す。
//   ふるさと納税の「正式方式」（地方税法37条の2第11項）は、住民税ベースの課税総所得金額と
//   人的控除差調整額を必要とする。所得税ベースの所得控除合計1つからは数学的に導出できないため、
//   人的控除は「控除額」ではなく「事実」（誰が何歳で所得がいくらか）を受け取る。
//
// 根拠条文（URL は data/*.json の「出典」に記載）
//   所得税法 28条          給与所得・給与所得控除額・別表第五
//   所得税法 76条・77条    生命保険料控除・地震保険料控除
//   所得税法 79〜84条の2   障害者・寡婦・ひとり親・勤労学生・配偶者・扶養・特定親族特別控除
//   所得税法 86条          基礎控除
//   所得税法 87条          所得控除の順序
//   所得税法 89条          税率（課税総所得金額と課税退職所得金額に共通・累進）
//   租税特別措置法 41条の16の2   基礎控除の特例（令和7年分以後の上乗せ）
//   租税特別措置法 41条の3の11   所得金額調整控除
//   租税特別措置法 31条・32条・37条の10・37条の11・8条の4  分離課税
//   地方税法 34条・35条・314条の2・314条の3  住民税の所得控除・所得割の税率
//   地方税法 37条・314条の6                  調整控除（人的控除差額表）
//   地方税法 37条の2第11項1号                人的控除差調整額
//   地方税法 20条の4の2                      端数計算
//   国税通則法 118条1項・119条1項            端数計算
//   復興財源確保法 12条・13条                復興特別所得税
//
// 金額・税率はこのファイルに書かない。すべて data/*.json から受け取る（設計原則3）。

import { pick_version } from "./version_pick.js";

// ── 共通の小道具 ──────────────────────────────────────────

/** 上限つきの区分表から、値が収まる行を取り出す。上限 null は「上限なし」。 */
function find_row(table, value, key) {
  return table.find((r) => r[key] === null || value <= r[key]);
}

/**
 * 「定額 ＋（値 − 起点）× 率」型の速算表を評価する。
 * 行に「最低保障額」があるときは、その額を下回らない
 * （所法28条3項1号（令和8年分以後）の「六十九万円に満たない場合には、六十九万円」）。
 */
function eval_sokusan(table, value, key) {
  const row = find_row(table, value, key);
  const gaku =
    row["定額"] +
    ((value - row["起点"]) * row["超過分の率パーセント"]) / 100;
  return row["最低保障額"] !== undefined
    ? Math.max(gaku, row["最低保障額"])
    : gaku;
}

/**
 * 「N円の整数倍の金額から M円を控除した金額」に切り下げる。
 * 所法83条の2第1項1号ロ（5万円の整数倍から3万円）・84条の2第1項2号（10万円の整数倍から8万円）、
 * および地方税法34条1項10号の2・12号の同旨の規定。
 * その形の金額でないときは「満たないもののうち最も多い金額」＝下に丸める。
 */
function floor_to_step(value, step, minus) {
  // value 以下で (step * n - minus) の形になる最大の金額
  const n = Math.floor((value + minus) / step);
  return n * step - minus;
}

// ── 給与所得 ──────────────────────────────────────────────

/**
 * 給与所得の金額を求める。所法28条2項・3項・4項。
 *
 * 収入が660万円未満のときは4項により別表第五を使う（3項の速算式ではない）。
 * 別表第五は「所得が零となる区間」「収入から定額を引く区間」「刻みの区間（各区分の下限に
 * 3項の速算式を当てた金額）」の3段でできている。しきい値はすべて data 側に持たせてある。
 * ★表そのものは持たず、しきい値と刻みから再現している。
 *   原文との全行照合は `node tools/verify_besshi5.mjs` で行う（年分ごとに回す）。
 *
 * ★刻みの区間の下限は「刻みの倍数」とは限らない。
 *   令和8年分の別表第五は 2,026,000 から始まり、最初の1区分だけ幅が2,000円（2,026,000〜2,028,000）で、
 *   以後 2,028,000 から4,000円刻みに揃う。単純に floor(収入/4,000)×4,000 とすると
 *   この区間で下限を2,000円低く取り、給与所得を2,000円少なく返す。
 *   そこで区間の開始額で下限を止める（令和7年分は開始額1,900,000が4,000の倍数なので何も起きない）。
 *
 * 660万円以上は3項の速算式で、別表第五の備考により1円未満切捨て。
 */
export function calc_kyuyo_shotoku(shunyu, setting) {
  if (shunyu <= 0) return { kingaku: 0, besshi5: false };
  const b5 = setting["別表第五"];
  const sokusan = setting["速算表"];

  if (shunyu < b5["適用する収入の上限"]) {
    if (shunyu < b5["所得が零となる収入の上限"]) {
      return { kingaku: 0, besshi5: true };
    }
    if (shunyu < b5["収入から定額を引く区間の上限"]) {
      return { kingaku: shunyu - b5["その区間の定額"], besshi5: true };
    }
    // 刻みの区分の「下限」に速算式を当てる（＝別表第五の値そのもの）
    const kizami = b5["刻み"];
    const kaishi = b5["収入から定額を引く区間の上限"]; // ＝刻みの区間の開始額
    const kagen = Math.max(kaishi, Math.floor(shunyu / kizami) * kizami);
    return { kingaku: kagen - eval_sokusan(sokusan, kagen, "収入の上限"), besshi5: true };
  }

  // 660万円以上：所法28条3項の速算式。1円未満切捨て（別表第五 備考）
  const kojo = eval_sokusan(sokusan, shunyu, "収入の上限");
  return { kingaku: Math.floor(shunyu - kojo), besshi5: false };
}

/**
 * 所得金額調整控除を求める。措法41条の3の11第1項・2項。
 * ★1項 → 2項の順に適用する（2項本文が「前項の規定による控除をした残額」を前提にしている）。
 * 給与所得から控除する。
 */
export function calc_shotoku_kingaku_chosei_kojo(
  kyuyo_shunyu,
  kyuyo_shotoku,
  nenkin_zasshotoku,
  jinteki,
  setting,
  nenrei_setting,
) {
  const ko1_setting = setting["子育て等"];
  let ko1 = 0;
  if (kyuyo_shunyu > ko1_setting["適用する給与収入の下限"]) {
    const taisho =
      jinteki["honnin_shogaisha"] === "tokubetsu" ||
      (jinteki["haigusha"] &&
        jinteki["haigusha"]["shogaisha"] === "tokubetsu") ||
      jinteki["fuyo_shinzoku"].some(
        (f) =>
          f["nenrei"] < ko1_setting["対象年齢未満"] ||
          f["shogaisha"] === "tokubetsu",
      );
    if (taisho) {
      const shunyu = Math.min(kyuyo_shunyu, ko1_setting["収入の上限"]);
      ko1 =
        ((shunyu - ko1_setting["適用する給与収入の下限"]) *
          ko1_setting["率パーセント"]) /
        100;
    }
  }

  const ko2_setting = setting["給与と年金の併用"];
  const nokori = Math.max(kyuyo_shotoku - ko1, 0);
  let ko2 = 0;
  if (nokori + nenkin_zasshotoku > ko2_setting["各所得の上限"]) {
    ko2 =
      Math.min(nokori, ko2_setting["各所得の上限"]) +
      Math.min(nenkin_zasshotoku, ko2_setting["各所得の上限"]) -
      ko2_setting["控除する額"];
  }
  return { ko1, ko2, gokei: ko1 + ko2 };
}

// ── 基礎控除 ──────────────────────────────────────────────

/**
 * 所得税の基礎控除額を求める。所法86条1項 ＋ 措法41条の16の2第1項。
 *
 * 措法は「所法86条1項【第1号】に定める金額に加算する」構造で、柱書のしきい値以下の場合だけ働く。
 * ★令和9年分以後もしくみは残り、消えるのは柱書のしきい値（655万円 → 132万円）のほうである。
 *   加算額そのもの（132万円以下は37万円）は恒久措置。
 */
export function calc_kiso_kojo(gokei_shotoku, setting) {
  const honsoku = setting["本則"];
  const base = find_row(honsoku, gokei_shotoku, "合計所得の上限")["金額"];

  const tokurei = setting["特例"];
  // 措法は本則第1号（＝表の先頭行）に該当する場合にだけ加算する
  const dai1go = honsoku[tokurei["加算の対象となる本則の号"] - 1];
  if (
    gokei_shotoku <= tokurei["適用する合計所得の上限"] &&
    gokei_shotoku <= dai1go["合計所得の上限"]
  ) {
    const kasan = find_row(
      tokurei["加算表"],
      gokei_shotoku,
      "合計所得の上限",
    )["加算額"];
    return { kingaku: base + kasan, tokurei_tekiyo: true };
  }
  return { kingaku: base, tokurei_tekiyo: false };
}

/** 住民税の基礎控除額。地方税法34条2項。措置法の上乗せは住民税には無い。 */
export function calc_juminzei_kiso_kojo(gokei_shotoku, table) {
  return find_row(table, gokei_shotoku, "合計所得の上限")["金額"];
}

// ── 人的控除 ──────────────────────────────────────────────

/** 本人の合計所得金額から、配偶者控除・配偶者特別控除の3段階の区分名を返す。 */
function haigusha_band(honnin_gokei) {
  if (honnin_gokei <= 9000000) return "本人の合計所得900万円以下";
  if (honnin_gokei <= 9500000) return "本人の合計所得900万円超950万円以下";
  return "本人の合計所得950万円超1000万円以下";
}

/**
 * 配偶者特別控除の額。所法83条の2／地方税法34条1項10号の2。
 *
 * ★所得税は「95万円以下は38万円」、住民税は「100万円以下は33万円」で定額の帯が違うが、
 *   その先の算式はどちらも【38万円】を基準にする（地方税法の原文がそうなっている）。
 *   住民税で33万円を基準にすると誤る。基準額はデータに持たせてある。
 */
function calc_haigusha_tokubetsu(haigusha_gokei, honnin_gokei, setting) {
  if (haigusha_gokei > setting["配偶者の合計所得金額の上限"]) return 0;
  const kijun = setting["本人の合計所得900万円以下"];
  const shiki = kijun["算式"];

  let gaku;
  if (haigusha_gokei <= kijun["定額を適用する配偶者所得の上限"]) {
    gaku = kijun["定額"];
  } else if (haigusha_gokei <= shiki["適用する配偶者所得の上限"]) {
    // 「九十三万一円を超える部分の金額」を、5万円の整数倍から3万円を控除した金額に切り下げる。
    // ★「九十三万一円」＝930,001円（93万＋1円）。起点はデータに持たせてある
    const koeru = haigusha_gokei - shiki["起点"];
    gaku = shiki["基準額"] - floor_to_step(koeru, shiki["刻み"], shiki["刻みからの控除額"]);
  } else {
    gaku = kijun["上限を超える場合の金額"];
  }

  const band = haigusha_band(honnin_gokei);
  if (band === "本人の合計所得900万円以下") return gaku;
  const [bunshi, bunbo] = setting[band]["乗率"].split("/").map(Number);
  // 1万円未満切上げ（所法83条の2第1項2号・3号／地方税法34条1項10号の2ロ・ハ）
  return Math.ceil((gaku * bunshi) / bunbo / 10000) * 10000;
}

/**
 * 特定親族特別控除の額。所法84条の2／地方税法34条1項12号。
 * ★配偶者特別控除と同じく、住民税も算式の基準額は63万円（定額の帯だけが45万円）。
 */
function calc_tokutei_shinzoku(shinzoku_gokei, setting) {
  if (shinzoku_gokei > setting["特定親族の合計所得金額の上限"]) return 0;
  const row = find_row(setting["区分"], shinzoku_gokei, "合計所得の上限");
  if (row["金額"] !== undefined) return row["金額"];
  // 「超える部分の金額に二を乗じた金額」を、10万円の整数倍から8万円を控除した金額に切り下げる。
  // ★「八十四万一円」＝840,001円（84万＋1円）
  const koeru = (shinzoku_gokei - row["起点"]) * row["乗数"];
  return Math.max(
    row["基準額"] - floor_to_step(koeru, row["刻み"], row["刻みからの控除額"]),
    0,
  );
}

/**
 * 人的控除を項目ごとに計算する。
 * table には shotokuzei.json の「人的控除」または juminzei.json の「所得控除」を渡す。
 * ★式は1本、額はデータ。所得税と住民税で額だけが違う（扶養38万/33万など）。
 */
export function calc_jinteki_kojo(jinteki, honnin_gokei, table) {
  const nenrei = table["年齢区分"];
  const meisai = {
    shogaisha: 0,
    kafu: 0,
    hitorioya: 0,
    kinro_gakusei: 0,
    haigusha: 0,
    haigusha_tokubetsu: 0,
    fuyo: 0,
    tokutei_shinzoku_tokubetsu: 0,
  };

  // 本人の障害者控除（所法79条1項／地方税法34条1項6号）
  if (jinteki["honnin_shogaisha"]) {
    meisai.shogaisha +=
      table["障害者"][
        jinteki["honnin_shogaisha"] === "tokubetsu" ? "特別" : "一般"
      ];
  }
  if (jinteki["honnin_kafu"]) meisai.kafu = table["寡婦"];
  if (jinteki["honnin_hitorioya"]) meisai.hitorioya = table["ひとり親"];
  if (jinteki["honnin_kinro_gakusei"]) meisai.kinro_gakusei = table["勤労学生"];

  const band = haigusha_band(honnin_gokei);
  const h = jinteki["haigusha"];
  if (h && honnin_gokei <= table["控除対象配偶者となる本人の合計所得の上限"]) {
    if (h["gokei_shotoku"] <= table["同一生計配偶者の合計所得要件"]) {
      // 控除対象配偶者（所法83条／地方税法34条1項10号）
      meisai.haigusha =
        table["配偶者控除"][band][
          h["nenrei"] >= nenrei["老人扶養親族・老人控除対象配偶者"]
            ? "老人"
            : "一般"
        ];
    } else {
      meisai.haigusha_tokubetsu = calc_haigusha_tokubetsu(
        h["gokei_shotoku"],
        honnin_gokei,
        table["配偶者特別控除"],
      );
    }
  }
  // 同一生計配偶者が障害者である場合（本人の所得にかかわらず適用される）
  if (h && h["shogaisha"] && h["gokei_shotoku"] <= table["同一生計配偶者の合計所得要件"]) {
    meisai.shogaisha += h["dokyo_tokubetsu"]
      ? table["障害者"]["同居特別"]
      : table["障害者"][h["shogaisha"] === "tokubetsu" ? "特別" : "一般"];
  }

  for (const f of jinteki["fuyo_shinzoku"]) {
    const is_fuyo = f["gokei_shotoku"] <= table["扶養親族の合計所得要件"];
    if (is_fuyo) {
      // 扶養控除（所法84条＋措法41条の16／地方税法34条1項11号・4項）
      if (f["nenrei"] >= nenrei["扶養控除の対象となる年齢"]) {
        if (f["nenrei"] >= nenrei["老人扶養親族・老人控除対象配偶者"]) {
          meisai.fuyo += f["dokyo_rokei_sonzoku"]
            ? table["扶養控除"]["同居老親等"]
            : table["扶養控除"]["老人"];
        } else if (
          f["nenrei"] >= nenrei["特定扶養親族"]["以上"] &&
          f["nenrei"] < nenrei["特定扶養親族"]["未満"]
        ) {
          meisai.fuyo += table["扶養控除"]["特定"];
        } else {
          meisai.fuyo += table["扶養控除"]["一般"];
        }
      }
    } else if (
      f["nenrei"] >= nenrei["特定扶養親族"]["以上"] &&
      f["nenrei"] < nenrei["特定扶養親族"]["未満"] &&
      f["gokei_shotoku"] <= table["特定親族の合計所得要件"]
    ) {
      // 特定親族特別控除（所法84条の2／地方税法34条1項12号）
      meisai.tokutei_shinzoku_tokubetsu += calc_tokutei_shinzoku(
        f["gokei_shotoku"],
        table["特定親族特別控除"],
      );
    }
    // 扶養親族・同一生計配偶者の障害者控除
    if (f["shogaisha"] && is_fuyo) {
      meisai.shogaisha += f["dokyo_tokubetsu"]
        ? table["障害者"]["同居特別"]
        : table["障害者"][f["shogaisha"] === "tokubetsu" ? "特別" : "一般"];
    }
  }

  const gokei = Object.values(meisai).reduce((a, b) => a + b, 0);
  return { meisai, gokei };
}

// ── 物的控除 ──────────────────────────────────────────────

/** 生命保険料控除。所法76条／地方税法34条1項5号。3区分それぞれ上限つき、合計にも上限。 */
export function calc_seimei_hokenryo_kojo(shiharai, setting) {
  // 新旧の両方を支払った場合、その区分の控除額の上限が別に定められている
  const joge_ryoho = setting["新旧両方を支払った場合の当該区分の上限"];

  const one = (shin, kyu, shin_t, kyu_t) => {
    const gs =
      shin > 0
        ? Math.min(
            eval_sokusan(shin_t["速算表"], shin, "支払額の上限"),
            shin_t["上限"],
          )
        : 0;
    const gk =
      kyu > 0
        ? Math.min(
            eval_sokusan(kyu_t["速算表"], kyu, "支払額の上限"),
            kyu_t["上限"],
          )
        : 0;
    if (shin > 0 && kyu > 0) return Math.min(gs + gk, joge_ryoho);
    return Math.max(gs, gk);
  };

  const shin_t = setting["新生命保険料等"];
  const kyu_t = setting["旧生命保険料等"];
  const kaigo_t = setting["介護医療保険料"];

  const seimei = one(shiharai["shin_seimei"] ?? 0, shiharai["kyu_seimei"] ?? 0, shin_t, kyu_t);
  const nenkin = one(shiharai["shin_nenkin"] ?? 0, shiharai["kyu_nenkin"] ?? 0, shin_t, kyu_t);
  const kaigo =
    (shiharai["kaigo_iryo"] ?? 0) > 0
      ? Math.min(
          eval_sokusan(kaigo_t["速算表"], shiharai["kaigo_iryo"], "支払額の上限"),
          kaigo_t["上限"],
        )
      : 0;

  return Math.min(seimei + nenkin + kaigo, setting["合計上限"]);
}

/** 地震保険料控除。所法77条／地方税法34条1項5号の3。 */
export function calc_jishin_hokenryo_kojo(shiharai, setting) {
  const jishin_setting = setting["地震保険料"];
  const jishin_shiharai = shiharai["jishin"] ?? 0;
  // 所得税は支払額そのまま、住民税は2分の1（算式の別はデータの「算式」に書いてある）
  const hanbun = jishin_setting["算式"].includes("1/2");
  const jishin = Math.min(
    hanbun ? Math.floor(jishin_shiharai / 2) : jishin_shiharai,
    jishin_setting["上限"],
  );

  const kyu_setting = setting["旧長期損害保険料の経過措置"];
  const kyu_shiharai = shiharai["kyu_chokiSongai"] ?? 0;
  const kyu =
    kyu_shiharai > 0
      ? Math.min(
          eval_sokusan(kyu_setting["速算表"], kyu_shiharai, "支払額の上限"),
          kyu_setting["上限"],
        )
      : 0;

  return Math.min(jishin + kyu, setting["合計上限"]);
}

// ── 所得の集計 ────────────────────────────────────────────

/** 総所得金額（総合課税の各所得の合計）。 */
function calc_sogo_shotoku(input, kyuyo_shotoku_go_chosei) {
  return (
    kyuyo_shotoku_go_chosei +
    input["nenkin_zasshotoku"] +
    input["jigyo_shotoku"] +
    input["fudosan_shotoku"] +
    input["sonota_sogo_shotoku"]
  );
}

/**
 * 合計所得金額。所法2条1項30号（措法31条3項1号等により分離課税分が読み込まれる）。
 * ★分離課税分は「特別控除前」の金額を算入する。措法35条1項1号が読み替えるのは
 *   「課税長期譲渡所得金額」の側だけで、合計所得金額に入る「長期譲渡所得の金額」ではない。
 *   つまり3,000万円特別控除で税額が0でも、合計所得金額が3,000万円あれば基礎控除は消える。
 * ★退職所得は所得税の合計所得金額には入るが、住民税は現年分離課税のため翌年度分には入らない。
 */
function calc_gokei_shotoku_kingaku(sogo, bunri, taishoku) {
  const bunri_gokei = bunri.reduce((a, b) => a + b["shotoku_kingaku"], 0);
  return { shotokuzei: sogo + bunri_gokei + taishoku, juminzei: sogo + bunri_gokei };
}

// ── 税額 ──────────────────────────────────────────────────

/** 課税所得金額。千円未満切捨て（通則法118条1項／地方税法20条の4の2第1項）。 */
export function calc_kazei_shotoku(sogo_shotoku, kojo_gokei) {
  return Math.floor(Math.max(sogo_shotoku - kojo_gokei, 0) / 1000) * 1000;
}

/**
 * 所得税額。所法89条。
 * ★「次の表の上欄に掲げる金額に区分してそれぞれの金額に…税率を乗じて計算した金額を合計した金額」
 *   ＝累進計算。速算表の「控除額」を使う形と一致する。
 */
// ★キー名が「課税退職所得金額の上限」なのは、この速算表を退職金メニューが先に使っていたため。
//   所法89条は課税総所得金額と課税退職所得金額を同じ表に当てはめるので、流用は条文どおり。
//   キー名を改名すると、公開直後に旧シェルのまま動いている端末の退職金メニューが壊れる
//   （data は即時反映・シェルは次回起動から。判断ログ D-16・D-27）。
const SOKUSAN_KEY = "課税退職所得金額の上限";

export function calc_shotokuzei_gaku(kazei_gaku, sokusan) {
  if (kazei_gaku <= 0) return 0;
  const row = find_row(sokusan, kazei_gaku, SOKUSAN_KEY);
  return (kazei_gaku * row["税率パーセント"]) / 100 - row["控除額"];
}

/** 限界税率（ふるさと納税の簡易方式が使う）。所法89条の該当区分の税率。 */
export function find_genkai_zeiritsu(kazei_gaku, sokusan) {
  if (kazei_gaku <= 0) return 0;
  return find_row(sokusan, kazei_gaku, SOKUSAN_KEY)["税率パーセント"];
}

// ── 住民税 ────────────────────────────────────────────────

/**
 * 地方税法37条1号イの金額（＝5万円＋人的控除差額表の合算）。
 * ★これは【調整控除】が使う値。ふるさと納税の人的控除差調整額とは別物なので混同しないこと。
 */
export function calc_jinteki_kojo_sagaku_37_1_i(jinteki, honnin_gokei, setting, table) {
  const sagaku = setting["人的控除差額表"];
  const nenrei = table["年齢区分"];
  let gokei = setting["基礎額"];

  if (jinteki["honnin_shogaisha"]) {
    gokei +=
      sagaku["障害者"][
        jinteki["honnin_shogaisha"] === "tokubetsu" ? "特別" : "一般"
      ];
  }
  if (jinteki["honnin_kafu"]) gokei += sagaku["寡婦"];
  if (jinteki["honnin_hitorioya"]) {
    gokei +=
      sagaku["ひとり親"][
        jinteki["honnin_hitorioya"] === "chichi" ? "父" : "母"
      ];
  }
  if (jinteki["honnin_kinro_gakusei"]) gokei += sagaku["勤労学生"];

  const band = haigusha_band(honnin_gokei);
  const h = jinteki["haigusha"];
  if (h && honnin_gokei <= table["控除対象配偶者となる本人の合計所得の上限"]) {
    if (h["gokei_shotoku"] <= table["同一生計配偶者の合計所得要件"]) {
      gokei +=
        sagaku["配偶者控除"][band][
          h["nenrei"] >= nenrei["老人扶養親族・老人控除対象配偶者"]
            ? "老人"
            : "一般"
        ];
    } else {
      // ★地方税法37条1号イ(7)は「配偶者の前年合計所得55万円未満」かつ「控除対象配偶者に該当しない」。
      //   同号8号の所得要件が58万円以下に引き上げられた結果、現行法では両方を満たす配偶者は存在せず、
      //   この加算は常に0になる（＝空集合）。条文の絶対値のまま実装し、新しい配特のブラケットに
      //   読み替えないこと（読み替えると発生しないはずの5万円が乗る）。
      const t = sagaku["配偶者特別控除"][band];
      if (h["gokei_shotoku"] < 550000) {
        gokei +=
          h["gokei_shotoku"] >= 500000
            ? t["配偶者所得50万円以上55万円未満"]
            : t["配偶者所得55万円未満"];
      }
    }
  }
  if (h && h["shogaisha"] && h["gokei_shotoku"] <= table["同一生計配偶者の合計所得要件"]) {
    gokei += h["dokyo_tokubetsu"]
      ? sagaku["障害者"]["同居特別"]
      : sagaku["障害者"][h["shogaisha"] === "tokubetsu" ? "特別" : "一般"];
  }

  for (const f of jinteki["fuyo_shinzoku"]) {
    const is_fuyo = f["gokei_shotoku"] <= table["扶養親族の合計所得要件"];
    if (is_fuyo && f["nenrei"] >= nenrei["扶養控除の対象となる年齢"]) {
      if (f["nenrei"] >= nenrei["老人扶養親族・老人控除対象配偶者"]) {
        gokei += f["dokyo_rokei_sonzoku"]
          ? sagaku["扶養控除"]["同居老親等"]
          : sagaku["扶養控除"]["老人"];
      } else if (
        f["nenrei"] >= nenrei["特定扶養親族"]["以上"] &&
        f["nenrei"] < nenrei["特定扶養親族"]["未満"]
      ) {
        gokei += sagaku["扶養控除"]["特定"];
      } else {
        gokei += sagaku["扶養控除"]["一般"];
      }
    }
    // ★特定親族特別控除は地方税法37条1号イの表に存在しない＝人的控除差に入らない（原文確認済み）
    if (f["shogaisha"] && is_fuyo) {
      gokei += f["dokyo_tokubetsu"]
        ? sagaku["障害者"]["同居特別"]
        : sagaku["障害者"][f["shogaisha"] === "tokubetsu" ? "特別" : "一般"];
    }
  }
  return gokei;
}

/**
 * ふるさと納税の「人的控除差調整額」。地方税法37条の2第11項1号。
 * ＝ 37条1号イの金額 ＋ max(所得税の基礎控除（措法適用後） − 48万円, 0)
 * ★調整控除が使う 37条1号イ単体とは別物。
 */
export function calc_jinteki_kojo_sa_chosei_gaku(sagaku_37_1_i, kiso_kojo_shotokuzei, setting) {
  return (
    sagaku_37_1_i +
    Math.max(kiso_kojo_shotokuzei - setting["基礎控除の基準額"], 0)
  );
}

/** 調整控除。地方税法37条・314条の6。前年の合計所得金額2,500万円超は適用しない。 */
export function calc_chosei_kojo(
  gokei_kazei_shotoku,
  sagaku_37_1_i,
  gokei_shotoku,
  setting,
  shitei_toshi,
) {
  if (gokei_shotoku > setting["適用する合計所得の上限"]) {
    return { dofuken: 0, shichoson: 0, gokei: 0 };
  }
  const kugiri = setting["合計課税所得金額の区切り"];
  const base =
    gokei_kazei_shotoku <= kugiri
      ? Math.min(sagaku_37_1_i, gokei_kazei_shotoku)
      : Math.max(sagaku_37_1_i - (gokei_kazei_shotoku - kugiri), setting["区切り超の下限"]);

  const r = setting["率パーセント"];
  const dofuken = (base * (shitei_toshi ? r["指定都市_道府県"] : r["道府県"])) / 100;
  const shichoson = (base * (shitei_toshi ? r["指定都市_市町村"] : r["市町村"])) / 100;
  return { dofuken, shichoson, gokei: dofuken + shichoson };
}

// ── 入口 ──────────────────────────────────────────────────

/**
 * 所得税・住民税の課税所得と税額を一括で計算する。
 * tables: { shotokuzei, juminzei, bunri_kazei, income_tax }
 */
export function calc_shotokuzei_engine(input, tables) {
  const sv = pick_version(tables.shotokuzei["版"], input.nen);
  const jv = pick_version(tables.juminzei["版"], input.nen);
  const bv = pick_version(tables.bunri_kazei["版"], input.nen);
  const rv = pick_version(tables.income_tax["版"], input.nen);
  if (!sv || !jv || !bv || !rv) {
    return { ok: false, riyu: `${input.nen}年分は収録していません。` };
  }

  const bunri = input.bunri ?? [];
  for (const b of bunri) {
    if (!bv["区分"].some((k) => k["key"] === b["kubun"])) {
      return { ok: false, riyu: `分離課税の区分「${b["kubun"]}」は収録していません。` };
    }
  }

  const chui = [];

  // ── 所得 ──
  const kyuyo = calc_kyuyo_shotoku(input.kyuyo_shunyu, sv["給与所得控除"]);
  const chosei = calc_shotoku_kingaku_chosei_kojo(
    input.kyuyo_shunyu,
    kyuyo.kingaku,
    input.nenkin_zasshotoku,
    input.jinteki,
    sv["所得金額調整控除"],
    sv["人的控除"]["年齢区分"],
  );
  const kyuyo_go = Math.max(kyuyo.kingaku - chosei.gokei, 0);
  const sogo = calc_sogo_shotoku(input, kyuyo_go);
  const gokei_shotoku = calc_gokei_shotoku_kingaku(
    sogo,
    bunri,
    input.taishoku_shotoku_kingaku ?? 0,
  );
  // 総所得金額等（寄附金の30%上限の分母）
  const soshotoku_kingaku_to =
    sogo + bunri.reduce((a, b) => a + b["kazei_hyojun"], 0);

  if (chosei.gokei > 0) chui.push("所得金額調整控除を適用しました。");
  if (bunri.some((b) => b["shotoku_kingaku"] > 0)) {
    chui.push(
      "分離課税の所得があります。取得費・特別控除・損益通算・繰越控除・軽減税率はこのツールでは計算しません。",
    );
  }

  // ── 控除（所得税ベース）──
  const kiso = calc_kiso_kojo(gokei_shotoku.shotokuzei, sv["基礎控除"]);
  const s_jinteki = calc_jinteki_kojo(
    input.jinteki,
    gokei_shotoku.shotokuzei,
    sv["人的控除"],
  );
  const s_butsuteki = {
    shakai_hoken: input.butsuteki["shakai_hoken_ryo"],
    shokibo: input.butsuteki["shokibo_kyosai"],
    seimei: calc_seimei_hokenryo_kojo(
      input.butsuteki["seimei_hokenryo"],
      sv["物的控除"]["生命保険料控除"],
    ),
    jishin: calc_jishin_hokenryo_kojo(
      input.butsuteki["jishin_hokenryo"],
      sv["物的控除"]["地震保険料控除"],
    ),
    iryohi: input.butsuteki["iryohi_kojo"],
    zasson: input.butsuteki["zasson_kojo"],
    kifukin: input.butsuteki["kifukin_kojo"],
  };
  const s_kojo_gokei =
    kiso.kingaku +
    s_jinteki.gokei +
    Object.values(s_butsuteki).reduce((a, b) => a + b, 0);

  // ── 控除（住民税ベース）──
  const j_kiso = calc_juminzei_kiso_kojo(
    gokei_shotoku.juminzei,
    jv["所得控除"]["基礎控除"],
  );
  const j_jinteki = calc_jinteki_kojo(
    input.jinteki,
    gokei_shotoku.juminzei,
    jv["所得控除"],
  );
  const j_butsuteki = {
    shakai_hoken: input.butsuteki["shakai_hoken_ryo"],
    shokibo: input.butsuteki["shokibo_kyosai"],
    seimei: calc_seimei_hokenryo_kojo(
      input.butsuteki["seimei_hokenryo"],
      jv["所得控除"]["生命保険料控除"],
    ),
    jishin: calc_jishin_hokenryo_kojo(
      input.butsuteki["jishin_hokenryo"],
      jv["所得控除"]["地震保険料控除"],
    ),
    iryohi: input.butsuteki["iryohi_kojo"],
    zasson: input.butsuteki["zasson_kojo"],
    kifukin: 0, // 住民税の寄附金は税額控除（37条の2）。所得控除ではない
  };
  const j_kojo_gokei =
    j_kiso +
    j_jinteki.gokei +
    Object.values(j_butsuteki).reduce((a, b) => a + b, 0);

  // ★所得控除を総所得金額から控除しきれない場合（分離課税所得から控除する場合）は扱わない
  if (s_kojo_gokei > sogo || j_kojo_gokei > sogo) {
    return {
      ok: false,
      riyu:
        "所得控除が総所得金額を超えています。分離課税の所得から所得控除を差し引く計算は" +
        "このツールでは扱いません。",
    };
  }

  // ── 課税所得と税額（所得税）──
  const s_kazei = calc_kazei_shotoku(sogo, s_kojo_gokei);
  const sanshutsu = calc_shotokuzei_gaku(s_kazei, rv["速算表"]);
  const bunri_zeigaku_meisai = bunri.map((b) => {
    const k = bv["区分"].find((x) => x["key"] === b["kubun"]);
    const kazei = Math.floor(b["kazei_hyojun"] / 1000) * 1000; // 千円未満切捨て
    return {
      kubun: b["kubun"],
      hyoji: k["表示"],
      zeigaku: (kazei * k["所得税率パーセント"]) / 100,
    };
  });
  // 基準所得税額（復興財確法12条）。このツールは税額控除を扱わないため算出税額と同額
  const kijun = sanshutsu + bunri_zeigaku_meisai.reduce((a, b) => a + b.zeigaku, 0);
  const fukko = (kijun * rv["復興特別所得税率パーセント"]) / 100;

  // ── 住民税 ──
  const j_kazei = calc_kazei_shotoku(sogo, j_kojo_gokei);
  const sagaku_37_1_i = calc_jinteki_kojo_sagaku_37_1_i(
    input.jinteki,
    gokei_shotoku.juminzei,
    jv["調整控除"],
    jv["所得控除"],
  );
  const sa_chosei = calc_jinteki_kojo_sa_chosei_gaku(
    sagaku_37_1_i,
    kiso.kingaku,
    jv["人的控除差調整額"],
  );
  const chosei_kojo = calc_chosei_kojo(
    j_kazei,
    sagaku_37_1_i,
    gokei_shotoku.juminzei,
    jv["調整控除"],
    input.shitei_toshi,
  );

  const jr = jv["所得割の税率パーセント"];
  const sogo_dofuken =
    (j_kazei * (input.shitei_toshi ? jr["指定都市_道府県"] : jr["道府県"])) / 100;
  const sogo_shichoson =
    (j_kazei * (input.shitei_toshi ? jr["指定都市_市町村"] : jr["市町村"])) / 100;

  const bunri_juminzei = bunri.map((b) => {
    const k = bv["区分"].find((x) => x["key"] === b["kubun"]);
    const r = k["住民税率パーセント"];
    const kazei = Math.floor(b["kazei_hyojun"] / 1000) * 1000;
    return {
      kubun: b["kubun"],
      dofuken: (kazei * (input.shitei_toshi ? r["指定都市_道府県"] : r["道府県"])) / 100,
      shichoson: (kazei * (input.shitei_toshi ? r["指定都市_市町村"] : r["市町村"])) / 100,
    };
  });

  // 20%上限の分母＝調整控除後・分離分を含む所得割額（地方税法附則により分離分も分母に入る）
  const wari_dofuken = Math.max(
    sogo_dofuken - chosei_kojo.dofuken +
      bunri_juminzei.reduce((a, b) => a + b.dofuken, 0),
    0,
  );
  const wari_shichoson = Math.max(
    sogo_shichoson - chosei_kojo.shichoson +
      bunri_juminzei.reduce((a, b) => a + b.shichoson, 0),
    0,
  );

  if (input.taishoku_shotoku_kingaku > 0) {
    chui.push(
      "退職所得は所得税の合計所得金額には算入しますが、住民税は現年分離課税のため翌年度分には算入しません。",
    );
  }

  return {
    ok: true,
    tekiyo_nenbun_hyoji: sv["適用年分表示"],
    juminzei_nendo_hyoji: `令和${input.nen - 2018 + 1}年度分`,

    kyuyo_shotoku: kyuyo.kingaku,
    kyuyo_besshi5_tekiyo: kyuyo.besshi5,
    shotoku_kingaku_chosei_kojo: chosei,
    sogo_shotoku_gokei: sogo,
    bunri_meisai: bunri,
    gokei_shotoku_kingaku: gokei_shotoku.shotokuzei,
    gokei_shotoku_kingaku_juminzei: gokei_shotoku.juminzei,
    soshotoku_kingaku_to,

    shotokuzei: {
      kiso_kojo: kiso.kingaku,
      kiso_kojo_tokurei_tekiyo: kiso.tokurei_tekiyo,
      jinteki_kojo_meisai: s_jinteki.meisai,
      butsuteki_kojo_meisai: s_butsuteki,
      shotoku_kojo_gokei: s_kojo_gokei,
      kazei_sogo_shotoku_kingaku: s_kazei,
      genkai_zeiritsu_percent: find_genkai_zeiritsu(s_kazei, rv["速算表"]),
      sanshutsu_zeigaku: sanshutsu,
      kijun_shotokuzei_gaku: kijun,
      fukko_tokubetsu_shotokuzei: fukko,
      shotokuzei_oyobi_fukko: kijun + fukko,
      bunri_zeigaku_meisai,
    },

    juminzei: {
      jinteki_kojo_meisai: j_jinteki.meisai,
      butsuteki_kojo_meisai: j_butsuteki,
      shotoku_kojo_gokei: j_kojo_gokei,
      kazei_sogo_shotoku_kingaku: j_kazei,
      gokei_kazei_shotoku_kingaku: j_kazei, // 退職・山林はこのエンジンでは常に0
      chosei_kojo: { jinteki_kojo_sagaku_37_1_i: sagaku_37_1_i, ...chosei_kojo },
      jinteki_kojo_sa_chosei_gaku: sa_chosei,
      kazei_sogo_minus_jinteki_sa: j_kazei - sa_chosei,
      shotokuwari: {
        sogo_dofuken,
        sogo_shichoson,
        bunri_meisai: bunri_juminzei,
        dofuken: wari_dofuken,
        shichoson: wari_shichoson,
        gokei: wari_dofuken + wari_shichoson,
      },
    },

    chui,
  };
}
