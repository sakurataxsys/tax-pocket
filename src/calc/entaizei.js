// 延滞税・利子税の計算
//
// 根拠条文（原文の所在は data/entaizei.json の「出典」）
//   国税通則法 60条2項  延滞税。法定納期限の翌日から完納日まで年14.6%。
//                       ただし納期限までの期間と、納期限の翌日から2月を経過する日までは年7.3%
//   国税通則法 61条     期間の特例（このツールでは控除しない。該当しうる入力では注意を出す）
//   国税通則法 64条     利子税（延納・物納・申告書の提出期限の延長）
//   国税通則法 10条1項  期間の計算。月で定めた期間は暦に従い、応当日の前日に満了する。
//                       応当日がない月は末日に満了する
//   国税通則法 118条3項 計算の基礎となる税額は1万円未満切捨て
//   国税通則法 119条4項 確定した附帯税は100円未満切捨て。全額1,000円未満なら全額切捨て
//   租税特別措置法 94条 延滞税の割合の特例／93条 利子税の割合の特例／96条2項 計算の過程は1円未満切捨て
//
// ★割合は年ごとに data/entaizei.json から受け取る。式で導かない。
//   令和2年度改正で利子税の式が変わっており（特例基準割合 → 利子税特例基準割合）、
//   1つの式を全年に当てると令和2年分以前を誤るため（同ファイルの注記）。

const MS_PER_DAY = 86400000;

/** "YYYY-MM-DD" → UTC 正午の時刻。正午に固定して夏時間・時差でずれないようにする */
function to_time(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d, 12);
}

/** UTC 正午の時刻 → "YYYY-MM-DD" */
function to_iso(time) {
  const d = new Date(time);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/** 日数を足した日付 */
export function add_days(iso, days) {
  return to_iso(to_time(iso) + days * MS_PER_DAY);
}

/** from から to までの日数（両端を含む）。to が from より前なら0 */
export function count_days(from, to) {
  const n = Math.round((to_time(to) - to_time(from)) / MS_PER_DAY) + 1;
  return n > 0 ? n : 0;
}

/**
 * 「納期限の翌日から二月を経過する日」を求める（国税通則法10条1項2号・3号）。
 *
 * 起算日＝納期限の翌日。2月後の応当する日の**前日**に満了する。
 * 最後の月に応当する日がないときは、その月の末日に満了する。
 *   例）納期限 3月15日 → 起算日 3月16日 → 応当日 5月16日 → 前日の 5月15日
 *   例）納期限12月30日 → 起算日12月31日 → 2月に31日はない → 2月末日（28日または29日）
 */
export function ni_tsuki_keika_bi(nokigen) {
  const kisan = add_days(nokigen, 1);
  const [y, m, d] = kisan.split("-").map(Number);
  const target_month = m + 2;
  const ty = y + Math.floor((target_month - 1) / 12);
  const tm = ((target_month - 1) % 12) + 1;
  // その月に応当する日があるか（0日を指定すると前月の末日が返る）
  const matsujitsu = new Date(Date.UTC(ty, tm, 0, 12)).getUTCDate();
  if (d > matsujitsu) {
    // 応当日がない → その月の末日に満了する（前日を取らない）
    return to_iso(Date.UTC(ty, tm - 1, matsujitsu, 12));
  }
  // 応当日の前日
  return add_days(to_iso(Date.UTC(ty, tm - 1, d, 12)), -1);
}

/** 適用年の割合を引く */
export function pick_wariai(wariai_list, year) {
  return wariai_list.find((w) => w["適用年"] === year) ?? null;
}

/**
 * 期間を暦年で切り分ける。年ごとに割合が変わるため。
 * 返すのは [{ 年, 開始, 終了, 日数 }]。
 */
export function split_by_year(from, to) {
  if (count_days(from, to) === 0) return [];
  const out = [];
  const from_year = Number(from.slice(0, 4));
  const to_year = Number(to.slice(0, 4));
  for (let y = from_year; y <= to_year; y++) {
    const kaishi = y === from_year ? from : `${y}-01-01`;
    const shuryo = y === to_year ? to : `${y}-12-31`;
    const nissu = count_days(kaishi, shuryo);
    if (nissu > 0) out.push({ 年: y, 開始: kaishi, 終了: shuryo, 日数: nissu });
  }
  return out;
}

/**
 * 1つの期間の税額を積む。
 * 各断片ごとに1円未満を切り捨てる（措置法96条2項「計算の過程における金額に一円未満の端数が
 * 生じたときは、これを切り捨てる」）。合算してから切り捨てると100円の境界で結果が変わる。
 */
function tsumiage(kiso_zeigaku, from, to, ritsu_key, tables) {
  const setting = tables.entaizei["端数処理"];
  const rows = [];
  for (const k of split_by_year(from, to)) {
    const w = pick_wariai(tables.entaizei["割合"], k.年);
    if (!w) return { ok: false, riyu: `${k.年}年の割合が収録されていません。` };
    const ritsu = w[ritsu_key];
    const gaku = Math.floor(
      (kiso_zeigaku * ritsu * k.日数) / (100 * setting["1年の日数"]),
    );
    rows.push({ ...k, 割合: ritsu, 適用年表示: w["適用年表示"], 金額: gaku });
  }
  return { ok: true, rows, gokei: rows.reduce((s, r) => s + r.金額, 0) };
}

/**
 * 延滞税・利子税を求める。
 *
 * input: {
 *   shurui: "延滞税" | "利子税"
 *   honzei: 本税の額（円）
 *   hotei_nokigen: 延滞税＝法定納期限／利子税＝申告書の提出期限（"YYYY-MM-DD"）
 *   nokigen: 納期限（期限内申告なら法定納期限と同じ。期限後申告・修正申告は提出日）
 *   kanno_bi: 完納した日（"YYYY-MM-DD"）
 *   is_kigengo: 期限後申告・修正申告か（納期限の入力を使うか）
 * }
 * tables: { entaizei: <entaizei.json> }
 */
export function calc_entaizei(input, tables) {
  const setting = tables.entaizei["端数処理"];

  if (input.hotei_nokigen < tables.entaizei["収録開始日"]) {
    return {
      ok: false,
      riyu:
        "平成26年1月1日より前を法定納期限とする計算は、この画面では扱いません。" +
        "当時は割合の決め方そのものが現在と異なります。",
    };
  }
  if (!(input.honzei > 0)) {
    return { ok: false, riyu: "本税の額を入力してください。" };
  }
  if (input.kanno_bi <= input.hotei_nokigen) {
    return {
      ok: true,
      zeigaku: 0,
      kiso_zeigaku: 0,
      kikan: [],
      riyu_zero: "完納日が法定納期限以前のため、延滞税は生じません。",
      shurui: input.shurui,
    };
  }

  // 国税通則法118条3項：計算の基礎となる税額は1万円未満切捨て
  const tan = setting["計算の基礎となる税額の切捨て単位"];
  const kiso_zeigaku = Math.floor(input.honzei / tan) * tan;
  if (kiso_zeigaku === 0) {
    return {
      ok: true,
      zeigaku: 0,
      kiso_zeigaku: 0,
      kikan: [],
      riyu_zero: `本税が${tan.toLocaleString()}円未満のため、計算の基礎となる税額が0円になります（国税通則法118条3項）。`,
      shurui: input.shurui,
    };
  }

  const kikan = [];

  if (input.shurui === "利子税") {
    // 提出期限の翌日から納付の日まで（1本）
    const r = tsumiage(
      kiso_zeigaku,
      add_days(input.hotei_nokigen, 1),
      input.kanno_bi,
      "利子税",
      tables,
    );
    if (!r.ok) return r;
    kikan.push({ 名称: "提出期限の翌日から納付の日まで", ...r });
  } else {
    const nokigen = input.is_kigengo ? input.nokigen : input.hotei_nokigen;
    if (nokigen < input.hotei_nokigen) {
      return { ok: false, riyu: "納期限が法定納期限より前になっています。入力を確認してください。" };
    }
    const keika_bi = ni_tsuki_keika_bi(nokigen);

    // 期間1：法定納期限の翌日から「納期限の翌日から2月を経過する日」まで（低い割合）
    const kikan1_to = input.kanno_bi < keika_bi ? input.kanno_bi : keika_bi;
    const r1 = tsumiage(
      kiso_zeigaku,
      add_days(input.hotei_nokigen, 1),
      kikan1_to,
      "延滞税_納期限の翌日から2月以内",
      tables,
    );
    if (!r1.ok) return r1;
    if (r1.rows.length > 0) {
      kikan.push({ 名称: "納期限の翌日から2月を経過する日まで", ...r1 });
    }

    // 期間2：その翌日から完納日まで（高い割合）
    if (input.kanno_bi > keika_bi) {
      const r2 = tsumiage(
        kiso_zeigaku,
        add_days(keika_bi, 1),
        input.kanno_bi,
        "延滞税_2月を経過した日以後",
        tables,
      );
      if (!r2.ok) return r2;
      kikan.push({ 名称: "2月を経過した日以後", ...r2 });
    }
  }

  // 国税通則法119条4項：100円未満切捨て。全額が1,000円未満なら全額切捨て
  const gokei = kikan.reduce((s, k) => s + k.gokei, 0);
  const kiritsute = setting["確定額の切捨て単位"];
  const zeigaku =
    gokei < setting["全額を切り捨てる下限"]
      ? 0
      : Math.floor(gokei / kiritsute) * kiritsute;

  return {
    ok: true,
    shurui: input.shurui,
    kiso_zeigaku,
    kikan,
    kiritsute_mae: gokei,
    zeigaku,
    riyu_zero:
      zeigaku === 0 && gokei > 0
        ? `計算した額が${setting["全額を切り捨てる下限"].toLocaleString()}円未満のため、全額を切り捨てます（国税通則法119条4項）。`
        : null,
    ni_tsuki_keika_bi:
      input.shurui === "延滞税"
        ? ni_tsuki_keika_bi(input.is_kigengo ? input.nokigen : input.hotei_nokigen)
        : null,
  };
}

/**
 * 国税通則法61条の期間の特例が働きうる入力かを判定する。
 * このツールは控除しないため、該当するときは画面に注意を出して過大に出ることを知らせる。
 */
export function needs_kikan_tokurei_chui(input) {
  if (input.shurui !== "延滞税" || !input.is_kigengo) return false;
  // 法定納期限から1年を経過した後に申告書を提出（＝納期限がその日）している場合
  return input.nokigen > add_days(input.hotei_nokigen, 365);
}
