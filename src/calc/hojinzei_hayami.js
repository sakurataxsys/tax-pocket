// 法人税の実効税率・均等割 早見表
//
// 根拠条文（原文と出典URLは data/hojinzei_hayami.json）
//   法人税法 66条1項・2項              法人税の税率（本則23.2%／中小の年800万円以下19%）
//   租税特別措置法 42条の3の2 1項1号   中小の軽減の特例（15%／所得10億円超の事業年度は17%）
//   地方法人税法 10条1項               法人税額 × 10.3%
//   地方税法 51条・314条の4            法人税割の標準税率（道府県1%・市町村6%）
//   地方税法 72条の24の7 1項3号        事業税の所得割（3.5 / 5.3 / 7.0%）
//   特別法人事業税法 7条3号            基準法人所得割額 × 37%
//   地方税法 52条・312条               均等割
//
// ★これは計算機ではない。入力は事業年度開始日だけで、所得は data の「所得規模の行」を使う。
//   法人税の計算機を作らないというのが第1版の設計判断（docs/仕様.md §3）。
//
// 対象は資本金1億円以下の普通法人に限る。軽減税率が使えない法人・外形標準課税・超過課税は
// 扱わず、画面に明示する（data の「扱わないもの」）。
//
// 率・金額・条文はこのファイルに書かない。すべて data/*.json から受け取る（設計原則3）。

/** 円未満を四捨五入する。早見表は目安なので、法定の端数処理は行わない */
function en(x) {
  return Math.round(x);
}

/** 段階税率の1区分ぶんを取り出す。lower 超 upper 以下の部分の金額 */
function bracket(shotoku, lower, upper) {
  const top = upper === null ? shotoku : Math.min(shotoku, upper);
  return Math.max(0, top - lower);
}

/**
 * 法人税額を求める。
 *
 * 年800万円以下の部分だけが軽減の対象。
 * ★措法42条の3の2の17%は法人税法66条2項の19%を置き換えるものなので、
 *   「所得10億円超の事業年度」でも 17% が掛かるのは**年800万円以下の部分だけ**。
 *   800万円を超える部分は本則23.2%のまま。ここを取り違えると大きく外れる。
 */
export function calc_hojinzei(shotoku, zeiritsu, keigen_tekiyo) {
  const h = zeiritsu["法人税"];
  const tokurei = zeiritsu["法人税の軽減の特例"];
  const kugiri = h["軽減の区切り"];

  let keigen_ritsu = h["中小の軽減"];
  if (keigen_tekiyo) {
    keigen_ritsu =
      shotoku > tokurei["所得のしきい値"] ? tokurei["所得が大きい事業年度の率"] : tokurei["率"];
  }

  const keigen_bun = bracket(shotoku, 0, kugiri);
  const honsoku_bun = bracket(shotoku, kugiri, null);
  return {
    税額: en((keigen_bun * keigen_ritsu) / 100 + (honsoku_bun * h["本則"]) / 100),
    軽減部分: keigen_bun,
    軽減の率: keigen_ritsu,
    本則部分: honsoku_bun,
    本則の率: h["本則"],
  };
}

/** 事業税の所得割。400万／800万の区切りで段階的に計算する */
export function calc_jigyozei(shotoku, zeiritsu) {
  const kubun = zeiritsu["事業税所得割"]["区分"];
  let lower = 0;
  let zei = 0;
  const uchiwake = [];
  for (const k of kubun) {
    const bun = bracket(shotoku, lower, k["上限以下"]);
    if (bun > 0) {
      zei += (bun * k["率"]) / 100;
      uchiwake.push({ 金額: bun, 率: k["率"] });
    }
    lower = k["上限以下"] ?? lower;
    if (k["上限以下"] === null) break;
  }
  return { 税額: en(zei), 内訳: uchiwake };
}

/**
 * 早見表（表1）を組み立てる。
 *
 * data: <hojinzei_hayami.json>
 * jigyo_nendo_kaishi_bi: 事業年度開始日（"YYYY-MM-DD"）。軽減の特例の適用判定に使う
 *
 * 日付は ISO 文字列の辞書順で比べる（new Date は UTC 解釈で前日になるため使わない）。
 */
export function build_zeigaku_hyo(data, jigyo_nendo_kaishi_bi) {
  const z = data["税率"];

  if (jigyo_nendo_kaishi_bi < data["収録開始日"]) {
    return {
      ok: false,
      riyu:
        "令和7年4月1日より前に開始する事業年度は、この画面では扱いません。" +
        "当時は中小法人の軽減税率の組み合わせが現在と異なります。",
    };
  }

  const tokurei = z["法人税の軽減の特例"];
  const keigen_tekiyo = jigyo_nendo_kaishi_bi <= tokurei["適用終了日"];

  const jumin = z["住民税法人税割"];
  const jumin_ritsu = jumin["道府県の標準税率"] + jumin["市町村の標準税率"];

  const gyo = data["所得規模の行"].map((shotoku) => {
    const hojin = calc_hojinzei(shotoku, z, keigen_tekiyo);
    const chiho = en((hojin["税額"] * z["地方法人税"]["率"]) / 100);
    const juminzei = en((hojin["税額"] * jumin_ritsu) / 100);
    const jigyo = calc_jigyozei(shotoku, z);
    const tokubetsu = en((jigyo["税額"] * z["特別法人事業税"]["率"]) / 100);
    const gokei = hojin["税額"] + chiho + juminzei + jigyo["税額"] + tokubetsu;
    return {
      所得: shotoku,
      法人税: hojin["税額"],
      法人税の内訳: hojin,
      地方法人税: chiho,
      住民税法人税割: juminzei,
      事業税: jigyo["税額"],
      事業税の内訳: jigyo["内訳"],
      特別法人事業税: tokubetsu,
      合計: gokei,
      負担率: gokei / shotoku,
    };
  });

  return {
    ok: true,
    行: gyo,
    軽減の適用: keigen_tekiyo,
    // 期限を過ぎたら黙って本則に戻さず1行出す（延長されていれば人が気づける。判断ログ D-20 と同じ）
    軽減の期限切れ: !keigen_tekiyo,
    軽減の適用終了日: tokurei["適用終了日"],
    事業年度開始日: jigyo_nendo_kaishi_bi,
  };
}

/**
 * 法定実効税率（会計の税効果で使う率）。
 *
 *   (法人税率 × (1 + 地方法人税率 + 住民税法人税割率) + 事業税率 × (1 + 特別法人事業税率))
 *     ÷ (1 + 事業税率 × (1 + 特別法人事業税率))
 *
 * ★分母の事業税率に (1 + 特別法人事業税率) を掛ける。
 *   損金になるのは事業税だけでなく特別法人事業税も同じであり、
 *   これを落とすと0.8ポイントほど高く出る。
 *
 * 軽減税率は所得の区分ごとに違うため、ここは本則（法人税23.2%・事業税7.0%）で出す。
 * 年800万円以下の部分はこれより低くなる。
 */
export function horitsu_jikko_zeiritsu(data) {
  const z = data["税率"];
  const hojin = z["法人税"]["本則"] / 100;
  const chiho = z["地方法人税"]["率"] / 100;
  const jumin =
    (z["住民税法人税割"]["道府県の標準税率"] + z["住民税法人税割"]["市町村の標準税率"]) / 100;
  const kubun = z["事業税所得割"]["区分"];
  const jigyo = kubun[kubun.length - 1]["率"] / 100; // 最上位の区分（800万円超）
  const tokubetsu = z["特別法人事業税"]["率"] / 100;

  const jigyo_kei = jigyo * (1 + tokubetsu);
  return (hojin * (1 + chiho + jumin) + jigyo_kei) / (1 + jigyo_kei);
}

/** 均等割の表（表2）。条文の区分をそのまま返すだけ */
export function build_kintowari_hyo(data) {
  return data["均等割"];
}
