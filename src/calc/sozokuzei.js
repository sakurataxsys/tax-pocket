// 相続税の概算
//
// 根拠条文（原文は data/sozokuzei.json の「出典」に URL を記載）
//   相続税法 12条1項6号・7号  保険金・退職手当金等の非課税（それぞれ別枠）
//   相続税法 15条            遺産に係る基礎控除・相続人の数・養子の数の制限
//   相続税法 16条            相続税の総額（表は data/sozokuzei_hyo.json に自動生成）
//   相続税法 17条            各相続人等の相続税額（課税価格の按分）
//   相続税法 18条            相続税額の加算（2割加算）
//   相続税法 19条            相続開始前7年以内の贈与の加算・贈与税額控除
//   相続税法 19条の2         配偶者に対する相続税額の軽減
//   民法 900条・901条        法定相続分・代襲相続人の相続分
//   国税通則法 118条1項・119条1項  端数計算
//
// 金額・税率はこのファイルに書かない。すべて data/*.json から受け取る（設計原則3）。
//
// ★このツールは財産を評価しない。課税価格の基になる評価額は入力値である（判断ログ D-04）。

import { pick_version } from "./version_pick.js";

/** 人数欄の上限。画面の max と同じ値にする */
export const SOZOKUNIN_MAX = 20;

// ------------------------------------------------------------------ 端数

/** 課税価格の千円未満切捨て（国税通則法118条1項） */
function floor_sen(gaku) {
  return Math.floor(gaku / 1000) * 1000;
}

/**
 * 納付すべき税額の百円未満切捨て（国税通則法119条1項）。
 * 負にはしない（贈与税額控除で引ききれない分は還付されない。相続税法19条1項）。
 */
function floor_hyaku(gaku) {
  return Math.max(0, Math.floor(gaku / 100) * 100);
}

// ------------------------------------------------------- 相続人の数と相続分

/**
 * 相続税法15条2項の「相続人の数」と、法定相続分を出すための構成を返す。
 *
 * 養子の数の制限は、実子があれば1人・実子がなければ2人（15条2項）。
 * ★代襲相続人となった直系卑属は15条3項2号で「実子とみなす」ので、
 *   制限の判定でも実子の側に数える。
 * ★相続放棄は「なかつたものとした場合における相続人の数」（15条2項括弧書き）なので、
 *   放棄は入力として受け取らない。
 */
export function count_sozokunin(kosei, setting) {
  const jisshi = kosei.jisshi ?? 0;
  const yoshi = kosei.yoshi ?? 0;
  const mago_yoshi = Math.min(kosei.mago_yoshi ?? 0, yoshi);
  const shibo_ko = kosei.shibo_ko ?? 0;
  const daishu = shibo_ko > 0 ? (kosei.daishu_mago ?? 0) : 0;

  // 15条3項2号：代襲相続人の孫は実子とみなす
  const jisshi_minashi = jisshi + daishu;
  const seigen = jisshi_minashi > 0 ? setting["実子がある場合"] : setting["実子がない場合"];
  const yoshi_yuko = Math.min(yoshi, seigen);
  // 制限で落ちるのは、まず孫養子でない養子から数えるほうが納税者に不利にならないが、
  // 落ちた養子は相続人の数にも法定相続分にも入らないため、2割加算の対象人数も減る。
  // 単純に「孫養子でない養子を先に有効とする」で固定する（結果が入力順に依存しないようにする）。
  const futsu_yoshi_yuko = Math.min(yoshi - mago_yoshi, yoshi_yuko);
  const mago_yoshi_yuko = yoshi_yuko - futsu_yoshi_yuko;

  const ko_kabu = jisshi + futsu_yoshi_yuko + mago_yoshi_yuko + (daishu > 0 ? 1 : 0);

  let junni = null;
  if (ko_kabu > 0) junni = "ko";
  else if ((kosei.chokkei_sonzoku ?? 0) > 0) junni = "sonzoku";
  else if ((kosei.kyodai ?? 0) > 0) junni = "kyodai";

  const haigusha = kosei.haigusha === true;
  let ketsuzoku_ninzu = 0;
  if (junni === "ko") ketsuzoku_ninzu = jisshi + futsu_yoshi_yuko + mago_yoshi_yuko + daishu;
  else if (junni === "sonzoku") ketsuzoku_ninzu = kosei.chokkei_sonzoku;
  else if (junni === "kyodai") ketsuzoku_ninzu = kosei.kyodai;

  return {
    ninzu: (haigusha ? 1 : 0) + ketsuzoku_ninzu,
    seigen_go: {
      haigusha,
      junni,
      jisshi,
      futsu_yoshi: futsu_yoshi_yuko,
      mago_yoshi: mago_yoshi_yuko,
      daishu,
      ko_kabu,
      chokkei_sonzoku: junni === "sonzoku" ? kosei.chokkei_sonzoku : 0,
      kyodai: junni === "kyodai" ? kosei.kyodai : 0,
    },
    yoshi_seigen_tekiyo: yoshi > yoshi_yuko,
  };
}

/**
 * 民法900条・901条の法定相続分を、相続人1人ずつの配列で返す。
 *
 * ★引数は count_sozokunin が返した「制限適用後の構成」にする。
 *   実際の養子の数で相続分を回すと相続税法16条の総額がずれるため、入口で誤用を塞ぐ。
 * ★代襲相続人（孫）は、その親（先に亡くなった子）1人分を頭数で等分する（901条1項ただし書）。
 *
 * nibai_kasan は相続税法18条の2割加算の対象か。
 *   配偶者・一親等の血族（子・養子・父母）＝対象外
 *   孫養子＝対象（18条2項）／代襲相続人の孫＝対象外（18条1項括弧書き）／兄弟姉妹＝対象
 */
export function hotei_sozokubun(seigen_go) {
  const list = [];
  const { haigusha, junni } = seigen_go;

  // 民法900条1〜3号：配偶者の相続分
  let haigusha_bun = 0;
  if (haigusha) {
    if (junni === "ko") haigusha_bun = 1 / 2;
    else if (junni === "sonzoku") haigusha_bun = 2 / 3;
    else if (junni === "kyodai") haigusha_bun = 3 / 4;
    else haigusha_bun = 1; // 血族相続人がいない
  }
  if (haigusha) list.push({ key: "haigusha", label: "配偶者", bun: haigusha_bun, nibai_kasan: false });

  const ketsuzoku_bun = haigusha ? 1 - haigusha_bun : junni === null ? 0 : 1;

  if (junni === "ko") {
    // 民法900条4号：子が数人あるときは相等しい。代襲は901条で1株を分ける
    const kabu = ketsuzoku_bun / seigen_go.ko_kabu;
    for (let i = 0; i < seigen_go.jisshi; i++) {
      list.push({ key: `jisshi${i}`, label: "子（実子）", bun: kabu, nibai_kasan: false });
    }
    for (let i = 0; i < seigen_go.futsu_yoshi; i++) {
      list.push({ key: `yoshi${i}`, label: "子（養子）", bun: kabu, nibai_kasan: false });
    }
    for (let i = 0; i < seigen_go.mago_yoshi; i++) {
      list.push({ key: `magoyoshi${i}`, label: "孫養子", bun: kabu, nibai_kasan: true });
    }
    if (seigen_go.daishu > 0) {
      const mago_bun = kabu / seigen_go.daishu;
      for (let i = 0; i < seigen_go.daishu; i++) {
        list.push({ key: `daishu${i}`, label: "孫（代襲相続）", bun: mago_bun, nibai_kasan: false });
      }
    }
  } else if (junni === "sonzoku") {
    const b = ketsuzoku_bun / seigen_go.chokkei_sonzoku;
    for (let i = 0; i < seigen_go.chokkei_sonzoku; i++) {
      list.push({ key: `sonzoku${i}`, label: "父母", bun: b, nibai_kasan: false });
    }
  } else if (junni === "kyodai") {
    const b = ketsuzoku_bun / seigen_go.kyodai;
    for (let i = 0; i < seigen_go.kyodai; i++) {
      list.push({ key: `kyodai${i}`, label: "兄弟姉妹", bun: b, nibai_kasan: true });
    }
  }
  return list;
}

// ------------------------------------------------------------ 贈与加算の期間

/**
 * 相続税法19条の加算対象期間を、相続開始日から求める。
 *
 * 令和5年度改正（令和5年法律第3号）の経過措置により、加算対象期間は3段階で動く。
 *   相続開始日が「3年据え置きの終期」まで      … 相続開始前3年以内
 *   その翌日から「固定日起算の終期」まで        … 経過措置の起点日から相続開始日まで
 *   それ以後                                    … 相続開始前7年以内
 *
 * ★この日付の切り分けは国税庁タックスアンサー No.4161（二次情報）で押さえている。
 *   改正法附則の原文は未確認（data/sozokuzei.json の「根拠の確認状況」・TASKS.md 参照）。
 *
 * 戻り値の choka_kojo_ari は「3年より前の部分があり、100万円控除が働くか」。
 */
export function zoyo_kasan_kikan(sozoku_kaishi_bi, setting) {
  const kaishi = String(sozoku_kaishi_bi);
  const san_nen_mae = minus_years(kaishi, 3);

  let kikan_kaishi;
  if (kaishi <= setting["３年据え置きの終期"]) {
    kikan_kaishi = san_nen_mae;
  } else if (kaishi <= setting["固定日起算の終期"]) {
    kikan_kaishi = setting["経過措置の起点日"];
  } else {
    kikan_kaishi = max_date(minus_years(kaishi, setting["加算年数"]), setting["経過措置の起点日"]);
  }

  return {
    kikan_kaishi,
    san_nen_mae,
    // 3年より前の期間が実際に存在するか
    choka_kikan_ari: kikan_kaishi < san_nen_mae,
    // 100万円控除が働くのは、適用開始日以後に開始した相続に限る
    choka_kojo_ari: kikan_kaishi < san_nen_mae && kaishi >= setting["延長分の控除の適用開始日"],
  };
}

/** "YYYY-MM-DD" から n 年前の日。文字列のまま扱う（日付の比較は文字列で行う） */
function minus_years(iso, n) {
  const [y, m, d] = iso.split("-");
  return `${String(Number(y) - n).padStart(4, "0")}-${m}-${d}`;
}

function max_date(a, b) {
  return a > b ? a : b;
}

// ------------------------------------------------------------------ 総額

/** 相続税法16条の表を積み上げる（超過累進。速算表の控除額は使わない） */
export function apply_zeiritsu(kingaku, hyo) {
  let zei = 0;
  for (const k of hyo) {
    const shita = k["下限"] ?? 0;
    if (kingaku <= shita) break;
    const ue = k["上限"] ?? Infinity;
    zei += (Math.min(kingaku, ue) - shita) * (k["税率パーセント"] / 100);
  }
  return zei;
}

// ------------------------------------------------------------------ 本体

/**
 * 相続税の概算を計算する。
 *
 * input: {
 *   sozoku_kaishi_bi: "YYYY-MM-DD"
 *   zaisan:      財産の評価額（保険金・退職手当金を除く。円）
 *   hokenkin:    生命保険金の合計額（円）
 *   taishokukin: 死亡退職金の合計額（円）
 *   saimu:       債務・葬式費用の合計額（円）
 *   zoyo_3nen:   加算対象期間のうち3年以内の贈与（円）
 *   zoyo_choka:  同じく3年より前の贈与（円）
 *   zoyozei:     上記の贈与に課された贈与税額（円）
 *   kosei: { haigusha, jisshi, yoshi, mago_yoshi, shibo_ko, daishu_mago, chokkei_sonzoku, kyodai }
 * }
 * tables: { sozokuzei: <sozokuzei.json>, sozokuzei_hyo: <sozokuzei_hyo.json> }
 */
export function calc_sozokuzei(input, tables) {
  const bi = String(input.sozoku_kaishi_bi ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(bi)) {
    return { ok: false, riyu: "相続開始日を入力してください。" };
  }
  const shuroku_kaishi = tables.sozokuzei["収録開始日"];
  if (bi < shuroku_kaishi) {
    return {
      ok: false,
      riyu: `${shuroku_kaishi} より前に開始した相続は収録していません。${tables.sozokuzei["収録開始日の理由"]}`,
    };
  }
  const version = pick_version(tables.sozokuzei["版"], Number(bi.slice(0, 4)));
  if (!version) {
    return { ok: false, riyu: `${bi.slice(0, 4)}年に開始した相続のデータが収録されていません。` };
  }

  if ((input.kosei?.shibo_ko ?? 0) > 1) {
    return {
      ok: false,
      riyu:
        "先に亡くなった子が2人以上いる場合の代襲相続は、このツールでは扱いません（民法901条の相続分を子ごとに分ける必要があるため）。",
    };
  }

  const { ninzu, seigen_go, yoshi_seigen_tekiyo } = count_sozokunin(
    input.kosei ?? {},
    version["養子の数の制限"],
  );
  if (ninzu === 0) {
    return {
      ok: false,
      riyu: "法定相続人がいない場合（受遺者だけが財産を取得する場合）は、このツールでは扱いません。",
    };
  }

  // ---- 課税価格の合計額
  const hikazei_waku = version["保険金等の非課税"]["相続人1人あたり"] * ninzu;
  // 相続税法12条1項6号・7号。保険金と退職手当金は別枠
  const hoken_kazei = Math.max(0, (input.hokenkin ?? 0) - hikazei_waku);
  const taishoku_kazei = Math.max(0, (input.taishokukin ?? 0) - hikazei_waku);

  const kikan = zoyo_kasan_kikan(bi, version["贈与加算"]);
  const zoyo_3nen = input.zoyo_3nen ?? 0;
  const zoyo_choka_nyuryoku = kikan.choka_kikan_ari ? (input.zoyo_choka ?? 0) : 0;
  // 相続税法19条1項括弧書き：3年以内以外の財産は「価額の合計額から百万円を控除した残額」
  const zoyo_choka = kikan.choka_kojo_ari
    ? Math.max(0, zoyo_choka_nyuryoku - version["贈与加算"]["延長分の控除額"])
    : zoyo_choka_nyuryoku;
  const zoyo_kasan = zoyo_3nen + zoyo_choka;

  const junshisan = Math.max(
    0,
    (input.zaisan ?? 0) + hoken_kazei + taishoku_kazei - (input.saimu ?? 0),
  );
  const kazei_kakaku_gokei = floor_sen(junshisan + zoyo_kasan);

  // ---- 基礎控除・課税遺産総額（相続税法15条1項）
  const kiso_kojo =
    version["基礎控除"]["定額"] + version["基礎控除"]["相続人1人あたり"] * ninzu;
  const kazei_isan = Math.max(0, kazei_kakaku_gokei - kiso_kojo);

  // ---- 相続税の総額（相続税法16条）
  const bunlist = hotei_sozokubun(seigen_go);
  const hyo = tables.sozokuzei_hyo["税率表"];
  const kazei_isan_meisai = [];
  let sogaku = 0;
  if (kazei_isan > 0) {
    if (bunlist.length === 1) {
      // 16条括弧書き：相続人が一人である場合は、控除した残額に直接税率を適用する
      const zei = apply_zeiritsu(kazei_isan, hyo);
      kazei_isan_meisai.push({ label: bunlist[0].label, bun: 1, shutoku: kazei_isan, zei });
      sogaku = zei;
    } else {
      for (const p of bunlist) {
        // 法定相続分に応ずる取得金額の千円未満切捨ては、法令の端数規定ではなく
        // 申告書第2表の実務に合わせたもの（このツールの判断）
        const shutoku = floor_sen(kazei_isan * p.bun);
        const zei = apply_zeiritsu(shutoku, hyo);
        kazei_isan_meisai.push({ label: p.label, bun: p.bun, shutoku, zei });
        sogaku += zei;
      }
    }
  }
  sogaku = Math.floor(sogaku);

  // ---- 2パターンの納付総額
  const pattern1 = calc_pattern(bunlist, {
    haigusha_shutoku: "hotei",
    sogaku,
    kazei_kakaku_gokei,
    zoyo_kasan,
    zoyozei: input.zoyozei ?? 0,
    version,
  });
  // 配偶者以外に相続人がいなければ「配偶者が取得しない場合」は成り立たない
  const pattern2 = seigen_go.haigusha && bunlist.length > 1
    ? calc_pattern(bunlist, {
        haigusha_shutoku: "nashi",
        sogaku,
        kazei_kakaku_gokei,
        zoyo_kasan,
        zoyozei: input.zoyozei ?? 0,
        version,
      })
    : null;

  return {
    ok: true,
    tekiyo_hyoji: version["適用表示"],
    ninzu,
    seigen_go,
    yoshi_seigen_tekiyo,
    hikazei_waku,
    hoken_kazei,
    taishoku_kazei,
    kikan,
    zoyo_kasan,
    zoyo_choka_kojo: kikan.choka_kojo_ari
      ? Math.min(zoyo_choka_nyuryoku, version["贈与加算"]["延長分の控除額"])
      : 0,
    kazei_kakaku_gokei,
    kiso_kojo,
    kazei_isan,
    kazei_isan_meisai,
    sogaku,
    pattern1,
    pattern2,
    haigusha_ari: seigen_go.haigusha,
  };
}

/**
 * 取得の前提を1つ置いて、各人の納付額と納付総額を出す（相続税法17条・18条・19条・19条の2）。
 *
 * haigusha_shutoku:
 *   "hotei" … 配偶者が法定相続分、ほかの相続人が残りを法定相続分の比で取得した場合
 *   "nashi" … 配偶者以外の相続人が法定相続分の比で取得した場合
 *
 * ★贈与加算は「配偶者以外の相続人1人が受けたもの」として、その人の課税価格に足す。
 *   相続税法19条は人ごとの規定で、100万円控除も贈与税額控除も人単位で効くため、
 *   誰が受けたかを決めないと各人の税額が出ない（画面にこの前提を表示する）。
 */
function calc_pattern(bunlist, o) {
  const { sogaku, kazei_kakaku_gokei, zoyo_kasan, zoyozei, version } = o;

  // 取得割合を決める
  const wariai = new Map();
  if (o.haigusha_shutoku === "hotei") {
    for (const p of bunlist) wariai.set(p.key, p.bun);
  } else {
    const hoka = bunlist.filter((p) => p.key !== "haigusha");
    const bunbo = hoka.reduce((s, p) => s + p.bun, 0);
    for (const p of bunlist) wariai.set(p.key, p.key === "haigusha" ? 0 : p.bun / bunbo);
  }

  // 贈与加算を引き受ける人（配偶者以外の相続人の先頭）
  const kasan_uke = bunlist.find((p) => p.key !== "haigusha")?.key ?? null;
  const isan_bubun = Math.max(0, kazei_kakaku_gokei - zoyo_kasan);

  const meisai = bunlist.map((p) => {
    const kazei_kakaku =
      floor_sen(isan_bubun * (wariai.get(p.key) ?? 0)) + (p.key === kasan_uke ? zoyo_kasan : 0);
    const wari = kazei_kakaku_gokei > 0 ? kazei_kakaku / kazei_kakaku_gokei : 0;
    // 相続税法17条：総額を課税価格の割合で按分する（割合は丸めない）
    let zei = sogaku * wari;
    // 相続税法18条：一親等の血族及び配偶者以外は20％加算
    if (p.nibai_kasan) zei *= 1 + version["相続税額の加算"]["加算率パーセント"] / 100;
    // 相続税法19条1項：加算された贈与財産に課された贈与税額を控除する（引ききれても還付しない）
    if (p.key === kasan_uke) zei -= zoyozei;
    return { key: p.key, label: p.label, kazei_kakaku, zei_before_keigen: zei };
  });

  // 相続税法19条の2：配偶者の税額軽減
  let haigusha_keigen = 0;
  const h = meisai.find((m) => m.key === "haigusha");
  if (h) {
    const haigusha_bun = bunlist.find((p) => p.key === "haigusha").bun;
    const only_haigusha = bunlist.length === 1;
    const i_gaku = only_haigusha
      ? kazei_kakaku_gokei
      : Math.max(
          kazei_kakaku_gokei * haigusha_bun,
          version["配偶者の税額軽減"]["最低保障額"],
        );
    const sukunai = Math.min(i_gaku, h.kazei_kakaku);
    const jogen =
      kazei_kakaku_gokei > 0 ? sogaku * (sukunai / kazei_kakaku_gokei) : 0;
    haigusha_keigen = Math.min(Math.max(0, h.zei_before_keigen), jogen);
  }

  const kaku = meisai.map((m) => ({
    label: m.label,
    kazei_kakaku: m.kazei_kakaku,
    nofu: floor_hyaku(m.key === "haigusha" ? m.zei_before_keigen - haigusha_keigen : m.zei_before_keigen),
  }));

  return {
    haigusha_shutoku: o.haigusha_shutoku,
    kasan_uke_label: kasan_uke ? bunlist.find((p) => p.key === kasan_uke).label : null,
    haigusha_keigen: Math.floor(haigusha_keigen),
    meisai: kaku,
    nofu_sogaku: kaku.reduce((s, m) => s + m.nofu, 0),
  };
}
