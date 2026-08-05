// 登録免許税の計算
//
// 根拠条文（原文は data/toroku_menkyozei_hyo.json に収録。URL は data/toroku_menkyozei.json の「出典」）
//   登録免許税法 9条        課税標準及び税率（別表第一による）
//   登録免許税法 10条       不動産等の価額
//   登録免許税法 15条       課税標準の金額の端数計算（全額が千円に満たないときは千円）
//   登録免許税法 19条       定率課税の場合の最低税額（計算した金額が千円に満たないときは千円）
//   登録免許税法 附則7条    不動産の価額は固定資産課税台帳の価格を基礎とできる（当分の間）
//   国税通則法 118条1項     課税標準の千円未満切捨て
//   国税通則法 119条1項     確定金額の百円未満切捨て
//   租税特別措置法 72条・72条の2・73条・75条  軽減
//
// 扱う範囲は別表第一の第1号（不動産の登記）と第24号（会社の商業登記）だけ。
// 金額・税率・条文はこのファイルに書かない。すべて data/*.json から受け取る（設計原則3）。

/** 木を歩いて葉（税率を持つノード）を集める */
export function collect_leaves(nodes, out = []) {
  for (const n of nodes) {
    if (n["税率"]) out.push(n);
    collect_leaves(n["子"], out);
  }
  return out;
}

/** 号のなかの葉を、画面のセレクトに出す順で返す（optgroup＝第1段の項目） */
export function leaf_groups(gou) {
  return gou["項目"].map((top) => ({
    見出し: `${top["ラベル"]}　${top["名称"]}`,
    葉: collect_leaves([top]),
  }));
}

/** パスから葉を1つ引く */
export function pick_leaf(hyo, path) {
  for (const g of hyo["号"]) {
    const found = collect_leaves(g["項目"]).find((l) => l["パス"] === path);
    if (found) return { 葉: found, 号: g };
  }
  return null;
}

/** その葉に紐づく軽減の一覧（画面のセレクトの中身） */
export function keigen_for_leaf(setting, path) {
  return setting["軽減"].filter((k) => k["対象の葉"].includes(path));
}

/**
 * 軽減の適用期間を、条文ごとに決まった日で判定する。
 *
 * 日付は ISO 文字列（"YYYY-MM-DD"）の辞書順で比べる。
 * new Date("2027-03-31") は UTC の午前0時に解釈され、日本時間では前日になるため使わない。
 *
 * ★どの日で判定するかは条文で違う（判断ログ D-22）。
 *   措法72条        「その間に…登記を受ける場合」        → 登記を受ける日
 *   措法72条の2・73・75「その間に…新築し、又は…取得し」 → 新築・取得の日
 */
export function judge_keigen(keigen_setting, hyo, input) {
  const teigi = hyo["軽減"][keigen_setting["キー"]];
  const hantei_bi =
    keigen_setting["期間の判定日"] === "新築・取得の日" ? input.shutoku_bi : input.toki_bi;

  if (!hantei_bi) {
    return { teigi, tekiyo: false, riyu: "判定に使う日が入力されていません。" };
  }
  if (hantei_bi < teigi["適用開始日"]) {
    return { teigi, tekiyo: false, hantei_bi, kikan_gai: "前" };
  }
  if (hantei_bi > teigi["適用終了日"]) {
    return { teigi, tekiyo: false, hantei_bi, kikan_gai: "後" };
  }
  return { teigi, tekiyo: true, hantei_bi };
}

/** "2024-03-31" の1年後 "2025-03-31" を返す（末日の繰上げはしない。境界の警告にしか使わない） */
export function ichinen_go(iso) {
  const [y, m, d] = iso.split("-");
  return `${Number(y) + 1}-${m}-${d}`;
}

/**
 * 定率課税の税額を求める。
 *
 *   1. 課税標準 … 千円未満切捨て（通則法118条1項）
 *                 → 全額が千円未満なら千円（登免法15条）
 *   2. 税額     … 課税標準 × 分子 ÷ 分母 の百円未満切捨て（通則法119条1項）
 *   3. 別表の但書の最低税額があれば、そこまで引き上げる
 *   4. なお千円未満なら千円（登免法19条）
 *
 * 3と4はどちらも千円単位の下限なので、順序を入れ替えても結果は変わらない。
 * 分子・分母は整数で持つ（「千分の一・五」＝15/10000）。浮動小数を作らない。
 */
export function calc_teiritsu(kazei_hyojun_nyuryoku, ritsu, tadashigaki) {
  const kirisute = Math.floor(kazei_hyojun_nyuryoku / 1000) * 1000;
  const kazei_hyojun = kirisute < 1000 ? 1000 : kirisute;
  const kirisute_shita = kirisute < 1000;

  const namachi = (kazei_hyojun * ritsu["分子"]) / ritsu["分母"];
  const hyaku_kirisute = Math.floor(namachi / 100) * 100;

  let zeigaku = hyaku_kirisute;
  let saitei = null;
  if (tadashigaki && tadashigaki["種別"] === "最低税額" && zeigaku < tadashigaki["税額"]) {
    zeigaku = tadashigaki["税額"];
    saitei = "但書";
  }
  if (zeigaku < 1000) {
    zeigaku = 1000;
    saitei = "登免法19条";
  }
  return {
    課税標準: kazei_hyojun,
    課税標準を千円にした: kirisute_shita,
    計算額: namachi,
    百円未満切捨て後: hyaku_kirisute,
    税額: zeigaku,
    最低税額の適用: saitei,
  };
}

/**
 * 登録免許税額を求める。
 *
 * input: {
 *   toki_bi:    登記を受ける日（"YYYY-MM-DD"）
 *   path:       登記の種類（別表の葉のパス。例 "第1号（二）ハ"）
 *   kingaku:    課税標準の金額（円）
 *   suryo:      課税標準の数量（個・件・箇所）
 *   keigen_key: 選んだ軽減のキー（未選択は null）
 *   shutoku_bi: 住宅用家屋を新築・取得した日（"YYYY-MM-DD"。使わない軽減では null）
 *   hojin_kubun: 二値定額の葉での法人の区分
 * }
 * tables: { toroku_menkyozei: <設定>, toroku_menkyozei_hyo: <税額表> }
 */
export function calc_toroku_menkyozei(input, tables) {
  const { toroku_menkyozei: setting, toroku_menkyozei_hyo: hyo } = tables;

  const found = pick_leaf(hyo, input.path);
  if (!found) return { ok: false, riyu: "登記の種類を選んでください。" };
  const { 葉: ha, 号: gou } = found;

  // 収録範囲より前は計算しない。当時は別表第一 第24号の構成が違うため、
  // 黙って現行の表を当てると、もっともらしい誤った税額になる。
  if (input.toki_bi < setting["収録開始日"]) {
    return {
      ok: false,
      riyu:
        "令和4年9月1日より前に受ける登記は、この画面では扱いません。" +
        "当時は別表第一 第24号の構成（支店所在地における登記）が現在と異なります。",
    };
  }

  const base = {
    ok: true,
    葉: ha,
    号: gou,
    注意: setting["葉ごとの注意"][ha["パス"]] ?? [],
    課税標準の補足: setting["課税標準の補足"][ha["課税標準"]] ?? null,
    適用: "本則",
    軽減: null,
    軽減の警告: null,
    一年の警告: null,
  };

  const ritsu_teigi = ha["税率"];

  // ------------------------------------------------ この画面では扱わない登記
  if (ritsu_teigi["種別"] === "扱わない") {
    return {
      ok: false,
      riyu:
        "この登記は税率が二段（消滅した会社の直前の資本金の額を境に千分の一・五と千分の七）になっており、" +
        "境目が財務省令に委ねられているため、この画面では計算しません。原文と財務省令を確認してください。",
      原文: ritsu_teigi["原文"],
    };
  }

  // ---------------------------------------------------------------- 定額課税
  if (ritsu_teigi["種別"] === "定額" || ritsu_teigi["種別"] === "二値定額") {
    const suryo = input.suryo;
    if (!(suryo > 0)) {
      return { ok: false, riyu: `${ha["課税標準"]}を入力してください。` };
    }

    let tanka = ritsu_teigi["税額"];
    let kubun_riyu = null;
    if (ritsu_teigi["種別"] === "二値定額") {
      if (input.hojin_kubun === "括弧書き適用") {
        tanka = ritsu_teigi["しきい値以下の税額"];
        kubun_riyu = "一般社団法人・一般財団法人（資本金がないため括弧書きの税額）";
      } else if (input.hojin_kubun === "会社") {
        if (!(input.kingaku > 0)) {
          return { ok: false, riyu: "資本金の額を入力してください。" };
        }
        // 「資本金の額が一億円以下の会社」＝1億円ちょうどは括弧書きの側
        if (input.kingaku <= ritsu_teigi["しきい値"]) {
          tanka = ritsu_teigi["しきい値以下の税額"];
          kubun_riyu = "資本金の額がしきい値以下の会社";
        } else {
          kubun_riyu = "資本金の額がしきい値を超える会社";
        }
      } else {
        kubun_riyu = "括弧書きの対象外（本則の税額）";
      }
    }

    // 但書「同一の申請書により二十個を超える…一件につき二万円」は最低税額ではなく別建ての額。
    // この画面は申請書1件分を計算するため、個数が超えたらそのまま置き換える。
    const tadashi = ha["但書"];
    if (tadashi && tadashi["種別"] === "個数超過の別建て" && suryo > tadashi["個数超"]) {
      return {
        ...base,
        種別: "定額",
        単価: tanka,
        数量: suryo,
        税額: tadashi["税額"],
        但書の適用: tadashi,
        区分の理由: kubun_riyu,
      };
    }

    return {
      ...base,
      種別: "定額",
      単価: tanka,
      数量: suryo,
      税額: tanka * suryo,
      但書の適用: null,
      区分の理由: kubun_riyu,
    };
  }

  // ---------------------------------------------------------------- 定率課税
  if (!(input.kingaku > 0)) {
    return { ok: false, riyu: `${ha["課税標準"]}を入力してください。` };
  }

  let ritsu = { 分子: ritsu_teigi["分子"], 分母: ritsu_teigi["分母"], 原文: ritsu_teigi["原文"] };
  let tekiyo = "本則";
  let keigen_result = null;
  let keigen_keikoku = null;
  let ichinen_keikoku = null;

  const kouho = keigen_for_leaf(setting, ha["パス"]);
  const erabu = kouho.find((k) => k["キー"] === input.keigen_key);
  if (erabu) {
    keigen_result = judge_keigen(erabu, hyo, input);
    if (keigen_result.tekiyo) {
      ritsu = { ...keigen_result.teigi["税率"] };
      tekiyo = "軽減";
      // 「取得後1年以内に登記を受けるものに限り」の要件（措法72条の2・73・75）
      if (erabu["期間の判定日"] === "新築・取得の日" && input.shutoku_bi) {
        if (input.toki_bi > ichinen_go(input.shutoku_bi)) {
          ichinen_keikoku = erabu["1年以内の注意"];
        }
      }
    } else {
      // 日付の整形は画面側で行う（このファイルは表示の文字列を組み立てない）
      keigen_keikoku = {
        種別: keigen_result.kikan_gai === "後" ? "期限後" : keigen_result.kikan_gai === "前" ? "開始前" : "判定できない",
        根拠: erabu["根拠"],
        適用開始日: keigen_result.teigi["適用開始日"],
        適用終了日: keigen_result.teigi["適用終了日"],
        理由: keigen_result.riyu ?? null,
      };
    }
  }

  const keisan = calc_teiritsu(input.kingaku, ritsu, ha["但書"]);

  return {
    ...base,
    種別: "定率",
    適用: tekiyo,
    税率: ritsu,
    軽減: erabu ?? null,
    軽減の定義: keigen_result?.teigi ?? null,
    軽減の判定日: keigen_result?.hantei_bi ?? null,
    軽減の警告: keigen_keikoku,
    一年の警告: ichinen_keikoku,
    ...keisan,
  };
}
