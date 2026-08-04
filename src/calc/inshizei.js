// 印紙税の税額の引き当て
//
// 根拠条文（原文は data/inshizei_hyo.json に収録。URL は data/inshizei.json の「出典」）
//   印紙税法 2条        課税物件（別表第一に掲げる「文書」に課税する）
//   印紙税法 3条        納税義務者（課税文書の作成者）
//   印紙税法 5条1号     非課税文書（別表第一の非課税物件の欄）
//   印紙税法 別表第一   課税物件表（第1号〜第20号）
//   租税特別措置法 91条 不動産譲渡契約書・建設工事請負契約書の軽減
//
// この画面は「作成日＋号＋記載金額」から税額を引くだけで、計算らしい計算はしない。
// 印紙税に円未満・千円未満の端数処理は無い（階級ごとの定額のため）。
//
// ★どの号に当たるかの判定（課税物件表の適用に関する通則1〜5）はここでは行わない。
//   1通の文書が2以上の号に該当する場合の所属の決定は人が行う。
//
// 金額・税率・条文はこのファイルに書かない。すべて data/*.json から受け取る（設計原則3）。

/** 画面の選択肢（第17号は1・2に分かれるため号だけでは引けない） */
export function pick_bunsho(inshizei, key) {
  return inshizei["文書"].find((b) => b.key === key) ?? null;
}

/**
 * 階級定額の区分表から1行を引く。
 * 「◯円を超え◯円以下のもの」なので、下限は超過、上限は以下。
 * 日付と同じくここも「以下」と「を超え」の取り違えが事故になる。
 */
export function hikiate_kaikyu(rows, kingaku) {
  return (
    rows.find(
      (r) =>
        (r["下限超"] === null || kingaku > r["下限超"]) &&
        (r["上限以下"] === null || kingaku <= r["上限以下"]),
    ) ?? null
  );
}

/**
 * 軽減措置（措法91条）を適用するかを、文書を作成した日で判定する。
 *
 * 日付は ISO 文字列（"YYYY-MM-DD"）の辞書順で比べる。
 * new Date("2027-03-31") は UTC の午前0時に解釈され、日本時間では前日になるため使わない。
 */
export function judge_keigen(bunsho, hyo, sakusei_bi, keigen_taisho) {
  if (!bunsho["軽減"] || !keigen_taisho) {
    return { hyo: null, kigen_gire: false };
  }
  const keigen = hyo["軽減税率"][bunsho["軽減"]];
  if (sakusei_bi > keigen["適用終了日"]) {
    // 期限を過ぎたら黙って本則に戻す。ただし画面には1行出す（延長されていれば人が気づける）
    return { hyo: null, kigen_gire: true, keigen };
  }
  if (sakusei_bi < keigen["適用開始日"]) {
    return { hyo: null, kigen_gire: false, keigen };
  }
  return { hyo: keigen, kigen_gire: false, keigen };
}

/**
 * 選んだ文書について、画面に出す入力欄を決める。
 *
 * 金額欄を出すのは「税額が金額で変わる号」と「金額だけで非課税が決まる号」。
 * 第8号・第18号のように作成者の条件が付く非課税は金額で判定しないため、金額欄も出さない。
 * 画面と計算で判断が食い違わないよう、この1か所だけで決める。
 */
export function nyuryoku_setting(bunsho, hyo) {
  const gou = hyo["号"].find((g) => g["号"] === bunsho["号"]);
  const kubun = gou["区分"][bunsho["使う区分"]];
  const shikii = bunsho["非課税しきい値を適用する"] ? gou["非課税しきい値"] : null;
  return {
    gou,
    kubun,
    shikii,
    金額を使う: kubun["種別"] === "階級定額" || shikii !== null,
    金額の呼称: kubun["金額の呼称"] ?? shikii?.["呼称"] ?? "記載金額",
  };
}

/**
 * 印紙税額を求める。
 *
 * input: {
 *   sakusei_bi: 文書を作成した日（"YYYY-MM-DD"）
 *   key: 画面の選択肢のキー（"1" "17-1" など）
 *   kingaku: 記載金額（円）
 *   kingaku_nashi: 記載金額がないか
 *   keigen_taisho: 軽減の対象となる文書か（第1号の不動産譲渡・第2号の建設工事請負）
 * }
 * tables: { inshizei: <inshizei.json>, inshizei_hyo: <inshizei_hyo.json> }
 */
export function calc_inshizei(input, tables) {
  const { inshizei, inshizei_hyo: hyo } = tables;

  const bunsho = pick_bunsho(inshizei, input.key);
  if (!bunsho) return { ok: false, riyu: "文書の種類を選んでください。" };

  // 収録範囲より前は計算しない。当時は軽減税率表も第17号の非課税枠も違うため、
  // 黙って現行の本則を出すと、もっともらしい誤った税額になる。
  if (input.sakusei_bi < inshizei["収録開始日"]) {
    return {
      ok: false,
      riyu:
        "平成26年4月1日より前に作成された文書は、この画面では扱いません。" +
        "当時は軽減税率表も第17号の非課税枠も現在と異なります。",
    };
  }

  const setting = nyuryoku_setting(bunsho, hyo);
  const gou = setting.gou;
  const honsoku_kubun = setting.kubun;
  const shikii = setting.shikii;
  const kingaku_wo_tsukau = setting["金額を使う"];
  const yobisho = setting["金額の呼称"];

  const base = {
    ok: true,
    bunsho,
    gou,
    tani: honsoku_kubun["単位"],
    kingaku_wo_tsukau,
    kingaku_no_yobisho: yobisho,
    hikazei: false,
    hikazei_riyu: null,
    tekiyo: "本則",
    keigen_kigen_gire: false,
    atehameta_gyo: null,
    kubun: honsoku_kubun,
  };

  // ------------------------------------------------ 記載金額がない場合の扱い
  if (kingaku_wo_tsukau && input.kingaku_nashi) {
    const nashi = bunsho["記載金額なしの扱い"];
    if (nashi["種別"] === "非課税") {
      return { ...base, zeigaku: 0, hikazei: true, hikazei_riyu: nashi["理由"] };
    }
    if (nashi["種別"] === "計算しない") {
      return { ok: false, riyu: nashi["理由"] };
    }
    // 「別の区分」＝第1号・第2号の「契約金額の記載のない契約書」、第17号の1→2
    // 軽減は「記載された契約金額が◯円を超えるもの」が対象なので、ここでは効かない
    const kubun =
      nashi["種別"] === "別の区分" ? gou["区分"][nashi["区分"]] : honsoku_kubun;
    if (kubun["種別"] === "階級定額") {
      return { ok: false, riyu: "記載金額を入力してください。" };
    }
    return { ...base, kubun, tani: kubun["単位"], zeigaku: kubun["税額"] };
  }

  // ---------------------------------------------------------- 金額を使う号
  if (kingaku_wo_tsukau) {
    if (!(input.kingaku > 0)) {
      return { ok: false, riyu: `${yobisho ?? "記載金額"}を入力してください。` };
    }

    // 非課税（別表第一の非課税物件の欄。印紙税法5条1号）
    if (shikii && input.kingaku < shikii["金額"]) {
      return { ...base, zeigaku: 0, hikazei: true, hikazei_riyu: shikii["原文"] };
    }

    const keigen = judge_keigen(bunsho, hyo, input.sakusei_bi, input.keigen_taisho);

    // 軽減表は本則より1区分少ない（措法91条は下限超のものだけが対象）。
    // 下限以下は軽減表に区分が無いので本則へ落とす。
    if (keigen.hyo && input.kingaku > keigen.hyo["軽減の対象となる契約金額の下限超"]) {
      const gyo = hikiate_kaikyu(keigen.hyo["行"], input.kingaku);
      if (!gyo) return { ok: false, riyu: "軽減税率表に該当する区分がありません。" };
      return {
        ...base,
        zeigaku: gyo["税額"],
        tekiyo: "軽減",
        keigen: keigen.hyo,
        atehameta_gyo: gyo,
      };
    }

    const honsoku_base = {
      ...base,
      keigen: keigen.keigen ?? null,
      keigen_kigen_gire: keigen.kigen_gire,
    };
    if (honsoku_kubun["種別"] === "定額") {
      return { ...honsoku_base, zeigaku: honsoku_kubun["税額"] };
    }
    const gyo = hikiate_kaikyu(honsoku_kubun["行"], input.kingaku);
    if (!gyo) return { ok: false, riyu: "税額表に該当する区分がありません。" };
    return { ...honsoku_base, zeigaku: gyo["税額"], atehameta_gyo: gyo };
  }

  // ------------------------------------------------------ 金額を使わない号
  return { ...base, zeigaku: honsoku_kubun["税額"] };
}
