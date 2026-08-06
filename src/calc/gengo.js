// 元号⇄西暦の変換（年単位のみ）
//
// 月日は扱わない。改元年（例：1912年）は前後どちらの元号でも成立するため、
// 西暦→元号の変換は該当する元号を両方（新旧）返す。
// 根拠・出典は data/gengo.json の「出典」を参照（このファイルに条文・詔書の原文は書かない）。

/** 今年より何年先までを警告なしで許すか（現行の元号のみに適用） */
const NEAR_FUTURE_YEARS = 10;

/** data/gengo.json の「元号一覧」を開始西暦年の昇順で返す */
function sorted_list(list) {
  return [...list].sort((a, b) => a["開始西暦年"] - b["開始西暦年"]);
}

/**
 * 元号年 → 西暦年。
 * 過去の元号（次の元号があるもの）は、その元号の最終年を超えたらエラー。
 * 現行の元号（次の元号が無いもの）は、今年+10年を超えたら警告付き（keikoku）で値を返す。
 */
export function seireki_from_gengo(mei, gengo_nen, list, this_year) {
  if (!Number.isInteger(gengo_nen) || gengo_nen < 1) {
    return { ok: false, riyu: "元号年は1以上の整数で入力してください。" };
  }
  const sorted = sorted_list(list);
  const idx = sorted.findIndex((g) => g["名称"] === mei);
  if (idx === -1) {
    return { ok: false, riyu: `「${mei}」に該当する元号がありません。` };
  }
  const cur = sorted[idx];
  const next = sorted[idx + 1];
  const seireki = cur["開始西暦年"] + gengo_nen - 1;

  if (next) {
    const saishu_nen = next["開始西暦年"] - cur["開始西暦年"] + 1;
    if (gengo_nen > saishu_nen) {
      return {
        ok: false,
        riyu: `${mei}は${saishu_nen}年までです（${mei}${gengo_nen}年にあたる年はありません）。`,
      };
    }
    return { ok: true, seireki, keikoku: null };
  }

  if (seireki > this_year + NEAR_FUTURE_YEARS) {
    return {
      ok: true,
      seireki,
      keikoku: `${mei}${gengo_nen}年は${NEAR_FUTURE_YEARS}年以上先です。入力を確認してください。`,
    };
  }
  return { ok: true, seireki, keikoku: null };
}

/**
 * 西暦年 → 元号年。改元年に該当する西暦は、前後の元号を両方 kouho に入れる（通常は1件）。
 * 明治の開始西暦年より前はエラー。今年+10年を超えたら警告付き（keikoku）で値を返す。
 */
export function gengo_from_seireki(seireki, list, this_year) {
  const sorted = sorted_list(list);
  const saitan = sorted[0]["開始西暦年"];
  if (!Number.isInteger(seireki) || seireki < saitan) {
    return { ok: false, riyu: `${saitan}年より前はこのツールでは扱いません。` };
  }

  const kouho = [];
  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i];
    const next = sorted[i + 1];
    const upper = next ? next["開始西暦年"] : Infinity;
    if (seireki >= cur["開始西暦年"] && seireki <= upper) {
      kouho.push({ mei: cur["名称"], gengo_nen: seireki - cur["開始西暦年"] + 1 });
    }
  }

  const keikoku =
    seireki > this_year + NEAR_FUTURE_YEARS
      ? `西暦${seireki}年は${NEAR_FUTURE_YEARS}年以上先です。次の改元が起きている可能性があり、この収録範囲では正しく変換できません。`
      : null;

  return { ok: true, kouho, keikoku };
}

/**
 * 年齢の概算（年単位）。入力年を生まれ年とみなした場合の、今年時点での満年齢の幅を返す。
 * 誕生日を迎えているかどうかで1歳ぶれるため、単一の値ではなく幅（saitei〜saiko）で返す。
 * 生まれ年が今年より後（未来）はエラー。
 */
export function calc_nenrei_gaisan(umare_seireki, ima_seireki) {
  if (umare_seireki > ima_seireki) {
    return { ok: false, riyu: "生まれた年が今年より後になっています。" };
  }
  const saiko = ima_seireki - umare_seireki;
  const saitei = Math.max(saiko - 1, 0);
  return { ok: true, saitei, saiko };
}
