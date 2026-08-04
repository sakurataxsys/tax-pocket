// 減価償却費の計算（定額法・定率法）
//
// 根拠条文（原文の URL は data/*.json の「出典」に記載）
//   法人税法施行令 48条の2  定額法・定率法の定義／定率法の償却率は定額法償却率の2倍
//                           （平成24年3月31日以前に取得したものは2.5倍）／償却保証額・改定取得価額
//   法人税法施行令 59条      事業年度の中途で事業の用に供した資産の月割（1月未満は1月に切上げ）
//   法人税法施行令 61条      償却累積額による限度（平成19年4月1日以後取得は取得価額−1円まで）
//   法人税法施行令 133条     少額の減価償却資産（10万円未満）
//   法人税法施行令 133条の2  一括償却資産（20万円未満・36月按分）
//   租税特別措置法 67条の5   中小企業者等の少額減価償却資産
//   耐用年数省令 3条         中古資産の簡便法（1項2号）・1年未満切捨て（5項）
//
// 償却率・改定償却率・保証率は data/shokyakuritsu.json（耐用年数省令の別表から自動生成）。
// 数値はこのファイルに1つも書かない（設計原則3）。
//
// ★端数処理
//   ・償却費の円未満 → 切捨て。法令上の明文は見当たらず（法令63条の2は財務省令へ委任）、
//     国税庁の設例に従っている。**要確認**
//   ・中古資産の簡便法の年数 → 1年未満切捨て（耐用年数省令3条5項）、2年未満は2年（同3条1項2号）
//   ・初年度の供用月数 → 暦に従い1月未満は1月に切上げ（法令59条2項）。月単位で入力するため常に整数

/** "2026-04-01" 形式の日付を「その月の通し番号」に直す。月単位の前後判定に使う */
function to_month_index(iso) {
  const [y, m] = iso.split("-").map(Number);
  return y * 12 + (m - 1);
}

/** 取得年月（数値）を同じ通し番号に直す */
export function month_index(year, month) {
  return year * 12 + (month - 1);
}

/**
 * 取得年月に対応する償却率表を選ぶ。
 * 表の適用開始日・適用終了日は shokyakuritsu.json が持っている（月初の日付のため月単位で判定できる）。
 */
export function pick_ritsu_table(shokyakuritsu, hoho, year, month) {
  const target = month_index(year, month);
  const keys = hoho === "定額法" ? ["定額法"] : ["定率法200", "定率法250"];
  for (const key of keys) {
    const t = shokyakuritsu["表"][key];
    if (!t) continue;
    const from = to_month_index(t["適用開始日"]);
    const to = t["適用終了日"] === null ? Infinity : to_month_index(t["適用終了日"]);
    if (target >= from && target <= to) return { key, table: t };
  }
  return null;
}

/** 取得年月に対応する少額減価償却資産の版を選ぶ */
export function pick_shogaku_version(versions, year, month) {
  const target = month_index(year, month);
  return (
    versions.find((v) => {
      const from = to_month_index(v["適用開始取得日"]);
      const to =
        v["適用終了取得日"] === null ? Infinity : to_month_index(v["適用終了取得日"]);
      return target >= from && target <= to;
    }) ?? null
  );
}

/**
 * 中古資産の簡便法による耐用年数（耐用年数省令3条1項2号）。
 *   全部経過：法定耐用年数 × 20%
 *   一部経過：（法定耐用年数 − 経過年数）＋ 経過年数 × 20%
 * 経過年数は月単位で計算し、最後に1年未満を切り捨てる（同3条5項）。2年未満は2年。
 */
export function calc_chuko_taiyo_nensu(hotei_nensu, keika_months, setting) {
  const wariai = setting["経過年数に乗じる割合パーセント"] / 100;
  const zenbu_wariai = setting["法定耐用年数の全部を経過した場合に乗じる割合パーセント"] / 100;
  const keika_nen = keika_months / 12;

  const nensu =
    keika_nen >= hotei_nensu
      ? hotei_nensu * zenbu_wariai
      : hotei_nensu - keika_nen + keika_nen * wariai;

  // 1年未満切捨て → 2年未満は2年
  return Math.max(Math.floor(nensu), setting["最短年数"]);
}

/**
 * 初年度の供用月数（1〜12）。事業年度は12か月を前提とする。
 * 事業の用に供した月から事業年度末（決算月）までを、両端を含めて数える。
 */
export function calc_kyoyo_tsukisu(kyoyo_month, kessan_month) {
  return ((kessan_month - kyoyo_month + 12) % 12) + 1;
}

/**
 * 取得価額から、該当しうる少額減価償却資産の制度を返す。
 * ★適用可否の判定はしない（青色申告・中小企業者等・貸付け用資産の除外・年間限度額があるため）。
 */
export function judge_shogaku(shutoku_kagaku, version) {
  if (!version) return [];
  const out = [];
  const ichiji = version["一時償却"];
  const ikkatsu = version["一括償却"];
  const tokurei = version["中小企業者等の特例"];

  if (shutoku_kagaku < ichiji["取得価額の上限"]) {
    out.push({
      名称: "全額を損金に算入できる（少額の減価償却資産）",
      説明: `取得価額が${ichiji["取得価額の上限"]}円未満のため、事業の用に供した事業年度に全額を損金算入できます。`,
      根拠: ichiji["根拠"],
    });
  }
  if (shutoku_kagaku < ikkatsu["取得価額の上限"]) {
    out.push({
      名称: `一括償却資産として${ikkatsu["償却月数"] / 12}年で均等償却できる`,
      説明: `取得価額が${ikkatsu["取得価額の上限"]}円未満のため、事業年度ごとに${ikkatsu["償却月数"]}分の当期の月数で償却する方法を選べます。`,
      根拠: ikkatsu["根拠"],
    });
  }
  if (shutoku_kagaku < tokurei["取得価額の上限"]) {
    out.push({
      名称: "中小企業者等の少額減価償却資産の特例の対象になりうる",
      説明: `取得価額が${tokurei["取得価額の上限"]}円未満のため、青色申告をしている中小企業者等であれば全額を損金算入できる場合があります（1事業年度あたり${tokurei["事業年度あたりの限度額"]}円まで）。`,
      根拠: tokurei["根拠"],
    });
  }
  return out;
}

/**
 * 定額法の償却スケジュール。
 * 各年度の償却限度額 ＝ 取得価額 × 定額法償却率（初年度は供用月数で月割）。
 * 取得価額 − 1円 に達したら終わり（法令61条1項2号イ）。
 */
function schedule_teigaku(shutoku_kagaku, ritsu, kyoyo_tsukisu, bibo_kagaku) {
  const nenagaku = Math.floor(shutoku_kagaku * ritsu["償却率"]);
  const rows = [];
  let boka = shutoku_kagaku;
  let n = 0;
  while (boka > bibo_kagaku && n < 200) {
    n++;
    const gendo =
      n === 1 ? Math.floor((nenagaku * kyoyo_tsukisu) / 12) : nenagaku;
    const shokyaku = Math.min(gendo, boka - bibo_kagaku);
    rows.push({
      年目: n,
      期首簿価: boka,
      償却限度額: shokyaku,
      期末簿価: boka - shokyaku,
      摘要: n === 1 && kyoyo_tsukisu < 12 ? `${kyoyo_tsukisu}か月分` : null,
    });
    boka -= shokyaku;
    if (shokyaku === 0) break; // 償却率が0の異常データで止まらなくなるのを防ぐ
  }
  return rows;
}

/**
 * 定率法の償却スケジュール。
 * 調整前償却額（期首簿価 × 償却率）が償却保証額（取得価額 × 保証率）に満たなくなった年度から、
 * その年度の期首簿価を改定取得価額として、改定償却率で毎年同額を償却する（法令48条の2第1項1号イ(2)・5項）。
 */
function schedule_teiritsu(shutoku_kagaku, ritsu, kyoyo_tsukisu, bibo_kagaku) {
  const hosho_gaku =
    ritsu["保証率"] === null ? null : Math.floor(shutoku_kagaku * ritsu["保証率"]);
  const rows = [];
  let boka = shutoku_kagaku;
  let kaitei_gaku = null; // 改定後の毎年の償却額（改定に入るまで null）
  let n = 0;

  while (boka > bibo_kagaku && n < 200) {
    n++;
    let gendo;
    let tekiyo = null;

    if (kaitei_gaku === null) {
      const chosei_mae = Math.floor(boka * ritsu["償却率"]);
      if (hosho_gaku !== null && chosei_mae < hosho_gaku) {
        // 改定取得価額（＝この年度の期首簿価）× 改定償却率 を以後毎年
        kaitei_gaku = Math.floor(boka * ritsu["改定償却率"]);
        gendo = kaitei_gaku;
        tekiyo = "改定償却率による";
      } else {
        gendo = n === 1 ? Math.floor((chosei_mae * kyoyo_tsukisu) / 12) : chosei_mae;
        if (n === 1 && kyoyo_tsukisu < 12) tekiyo = `${kyoyo_tsukisu}か月分`;
      }
    } else {
      gendo = kaitei_gaku;
      tekiyo = "改定償却率による";
    }

    const shokyaku = Math.min(gendo, boka - bibo_kagaku);
    rows.push({
      年目: n,
      期首簿価: boka,
      償却限度額: shokyaku,
      期末簿価: boka - shokyaku,
      摘要: tekiyo,
    });
    boka -= shokyaku;
    if (shokyaku === 0) break;
  }
  return rows;
}

/**
 * 減価償却費を計算する。
 *
 * input: {
 *   shutoku_kagaku: 取得価額（円）
 *   shutoku_year, shutoku_month: 取得し事業の用に供した年月（同じ月とみなす）
 *   kessan_month: 決算月（1〜12）
 *   taiyo_nensu: 耐用年数（中古のときは法定耐用年数）
 *   hoho: "定額法" | "定率法"
 *   is_chuko: 中古資産として取得したか
 *   keika_years, keika_months: 取得時点の経過年月（中古のときのみ）
 * }
 * tables: { shokyakuritsu: <shokyakuritsu.json>, genka_shokyaku: <genka_shokyaku.json> }
 */
export function calc_genka_shokyaku(input, tables) {
  const { shokyakuritsu, genka_shokyaku } = tables;

  const picked = pick_ritsu_table(
    shokyakuritsu,
    input.hoho,
    input.shutoku_year,
    input.shutoku_month,
  );
  if (!picked) {
    return {
      ok: false,
      riyu:
        "平成19年3月31日以前に取得した資産（旧定額法・旧定率法）は、このツールでは計算できません。",
    };
  }

  // 中古資産なら簡便法で耐用年数を置き換える
  let taiyo_nensu = input.taiyo_nensu;
  let chuko_note = null;
  if (input.is_chuko) {
    const keika_months = input.keika_years * 12 + input.keika_months;
    if (keika_months <= 0) {
      return { ok: false, riyu: "中古資産の経過年月を入力してください。" };
    }
    taiyo_nensu = calc_chuko_taiyo_nensu(
      input.taiyo_nensu,
      keika_months,
      genka_shokyaku["中古資産の簡便法"],
    );
    chuko_note =
      `法定耐用年数${input.taiyo_nensu}年・経過${input.keika_years}年${input.keika_months}か月` +
      ` → 簡便法で${taiyo_nensu}年`;
  }

  const ritsu = picked.table["行"][String(taiyo_nensu)];
  if (!ritsu) {
    return {
      ok: false,
      riyu: `耐用年数${taiyo_nensu}年は償却率表にありません（表は2年から100年まで）。`,
    };
  }

  const kyoyo_tsukisu = calc_kyoyo_tsukisu(input.shutoku_month, input.kessan_month);
  const bibo_kagaku = genka_shokyaku["備忘価額"];

  if (input.shutoku_kagaku <= bibo_kagaku) {
    return { ok: false, riyu: "取得価額を入力してください。" };
  }

  const schedule =
    input.hoho === "定額法"
      ? schedule_teigaku(input.shutoku_kagaku, ritsu, kyoyo_tsukisu, bibo_kagaku)
      : schedule_teiritsu(input.shutoku_kagaku, ritsu, kyoyo_tsukisu, bibo_kagaku);

  const shogaku_version = pick_shogaku_version(
    genka_shokyaku["少額減価償却資産"]["版"],
    input.shutoku_year,
    input.shutoku_month,
  );

  return {
    ok: true,
    hoho: input.hoho,
    ritsu_key: picked.key,
    ritsu_hyodai: picked.table["表題"],
    taiyo_nensu,
    chuko_note,
    shokyakuritsu: ritsu["償却率"],
    kaitei_shokyakuritsu: ritsu["改定償却率"] ?? null,
    hoshoritsu: ritsu["保証率"] ?? null,
    hosho_gaku:
      ritsu["保証率"] === null
        ? null
        : Math.floor(input.shutoku_kagaku * ritsu["保証率"]),
    kyoyo_tsukisu,
    bibo_kagaku,
    shonendo: schedule[0]?.["償却限度額"] ?? 0,
    schedule,
    shogaku: judge_shogaku(input.shutoku_kagaku, shogaku_version),
    shogaku_version_hyoji: shogaku_version?.["適用年分表示"] ?? null,
  };
}
