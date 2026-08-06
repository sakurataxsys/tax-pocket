// ハッシュルーティングと各画面の描画。
// 画面は index.html 1枚に載せる（#/taishokukin のようにハッシュで切り替える）。
// 動的 import は使わない。service worker が版ごとにまとめてキャッシュするため、
// 後から別の版のモジュールを取りに行く経路を作らない。

import {
  load_data,
  load_taishokukin_tables,
  load_genka_shokyaku_tables,
  load_inshizei_tables,
  load_toroku_menkyozei_tables,
  load_entaizei_tables,
  load_link_shu,
  load_hojinzei_hayami,
  load_gengo,
} from "./data.js";
import { APP_VERSION, KOUSHIN_ICHIRAN } from "./version.js";
import { calc_taishokukin } from "./calc/taishokukin.js";
import { pick_version } from "./calc/version_pick.js";
import { calc_genka_shokyaku } from "./calc/genka_shokyaku.js";
import { calc_inshizei, pick_bunsho, nyuryoku_setting } from "./calc/inshizei.js";
import {
  calc_toroku_menkyozei,
  leaf_groups,
  pick_leaf,
  keigen_for_leaf,
} from "./calc/toroku_menkyozei.js";
import { calc_entaizei, needs_kikan_tokurei_chui } from "./calc/entaizei.js";
import {
  build_zeigaku_hyo,
  build_kintowari_hyo,
  horitsu_jikko_zeiritsu,
} from "./calc/hojinzei_hayami.js";
import {
  seireki_from_gengo,
  gengo_from_seireki,
  calc_nenrei_gaisan,
} from "./calc/gengo.js";
import {
  format_en,
  format_number,
  format_nenbun,
  format_nen,
  format_ritsu,
  format_hizuke,
} from "./format.js";
import {
  h,
  page_title,
  field,
  money_input,
  number_input,
  select_input,
  select_group_input,
  date_input,
  check_input,
  result_card,
  breakdown,
  schedule_table,
  warn_line,
  note_block,
  message_box,
} from "./ui.js";

const root = document.getElementById("app");
const back_link = document.getElementById("back");

const MENU = [
  { path: "#/taishokukin", name: "退職金", desc: "退職所得の税額と手取り", ready: true },
  {
    path: "#/genka-shokyaku",
    name: "減価償却費",
    desc: "定額法・定率法",
    ready: true,
  },
  {
    path: "#/inshizei",
    name: "印紙税",
    desc: "契約書等の記載金額から",
    ready: true,
  },
  {
    path: "#/toroku-menkyozei",
    name: "登録免許税",
    desc: "登記の種類・課税標準から",
    ready: true,
  },
  {
    path: "#/entaizei",
    name: "延滞税・利子税",
    desc: "納付が遅れた日数から",
    ready: true,
  },
  {
    path: "#/gengo",
    name: "和暦・西暦",
    desc: "和暦⇄西暦・年齢の概算",
    ready: true,
  },
  {
    path: "#/link-shu",
    name: "リンク集",
    desc: "税額表・社会保険料率等（適用年度つき）",
    ready: true,
  },
  {
    path: "#/hojinzei-hayami",
    name: "法人税の早見表",
    desc: "実効税率・均等割",
    ready: true,
  },
  {
    path: "#/koushin",
    name: "更新の確認",
    desc: "この端末に入っている数値表の日付",
    ready: true,
  },
];

/**
 * 計算と結果の描画をまとめて包む。
 *
 * 改正で `data/*.json` の形が変わったとき、旧シェルの端末は次に起動し直すまで
 * 「旧ロジック＋新データ」で動く（sw.js の設計。判断ログ D-16）。
 * この間に計算が例外を投げると、イベントリスナの中なので黙って握り潰され、
 * **直前の計算結果が画面に残ったまま入力だけが変わる**。
 * 古い数字を新しい入力の結果と読み違えないよう、失敗しても必ず結果領域を差し替える。
 */
function show_result(area, build) {
  let nodes;
  try {
    nodes = build();
  } catch {
    area.replaceChildren(
      message_box(
        "計算できませんでした。税率表が新しくなっている可能性があります。" +
          "アプリをいったん閉じて開き直してください。",
      ),
    );
    return;
  }
  area.replaceChildren(...[nodes].flat());
}

// ------------------------------------------------------------ メニュー画面

function render_menu() {
  back_link.hidden = true;
  root.replaceChildren(
    page_title("税額ポケット", "関与先で使う税額計算ツール"),
    h("nav", { class: "menu" },
      MENU.map((m) =>
        m.ready
          ? h("a", { class: "menu__item", href: m.path },
              h("span", { class: "menu__name" }, m.name),
              h("span", { class: "menu__desc" }, m.desc),
            )
          : h("div", { class: "menu__item menu__item--soon" },
              h("span", { class: "menu__name" }, m.name),
              h("span", { class: "menu__desc" }, "準備中"),
            ),
      ),
    ),
  );
}

// -------------------------------------------------------------- 退職金画面

async function render_taishokukin() {
  back_link.hidden = false;
  root.replaceChildren(message_box("読み込んでいます…"));

  let tables;
  try {
    tables = await load_taishokukin_tables();
  } catch {
    root.replaceChildren(
      page_title("退職金"),
      message_box(
        "税率表を読み込めませんでした。通信できる場所で一度開くと、以後は電波がなくても使えます。",
      ),
    );
    return;
  }

  const shuroku = tables.taishokukin["収録年分"];
  const nen_options = [];
  for (let y = shuroku["最大"]; y >= shuroku["最小"]; y--) {
    nen_options.push({ value: y, label: format_nenbun(y) });
  }

  const in_nen = select_input(nen_options, shuroku["最大"]);
  const in_shunyu = money_input({ placeholder: "0" });
  const in_years = number_input({ min: 0, max: 80, placeholder: "0" });
  const in_months = number_input({ min: 0, max: 11, placeholder: "0" });
  const in_yakuin = number_input({ min: 0, max: 80, value: 0 });
  const in_shogai = check_input(
    "障害者になったことにより退職した",
    "退職所得控除額に100万円が加算されます",
  );
  const in_teishutsu = check_input(
    "「退職所得の受給に関する申告書」の提出を受けている",
    "提出がない場合は退職金の額に一律20.42%で源泉徴収します",
  );
  in_teishutsu.input.checked = true;

  const result_area = h("div", { class: "result-area" });

  const form = h("section", { class: "form" },
    field("適用年分", in_nen),
    field("退職金の額（円）", in_shunyu),
    h("div", { class: "field-row" },
      field("勤続年数（年）", in_years),
      field("うち1年未満（か月）", in_months, "1年に切り上げます"),
    ),
    field(
      "役員等勤続年数（年）",
      in_yakuin,
      "役員・議員・公務員としての勤続年数。該当しなければ0年",
    ),
    in_shogai,
    in_teishutsu,
  );

  function recalc() {
    const input = {
      shunyu: Number(String(in_shunyu.value).replace(/[^0-9]/g, "") || 0),
      kinzoku_years: Number(in_years.value || 0),
      kinzoku_months: Number(in_months.value || 0),
      yakuin_kinzoku_nensu: Number(in_yakuin.value || 0),
      is_shogai: in_shogai.input.checked,
      is_teishutsu: in_teishutsu.input.checked,
      nen: Number(in_nen.value),
    };

    if (input.shunyu <= 0 || input.kinzoku_years + input.kinzoku_months <= 0) {
      result_area.replaceChildren(
        message_box("退職金の額と勤続年数を入力してください。"),
      );
      return;
    }

    show_result(result_area, () => {
      const r = calc_taishokukin(input, tables);
      if (!r.ok) return message_box(r.riyu);
      const version = pick_version(tables.taishokukin["版"], input.nen);
      return render_result(r, input, version, tables.taishokukin["最終確認日"]);
    });
  }

  for (const el of [in_nen, in_shunyu, in_years, in_months, in_yakuin]) {
    el.addEventListener("input", recalc);
    el.addEventListener("change", recalc);
  }
  in_shogai.input.addEventListener("change", recalc);
  in_teishutsu.input.addEventListener("change", recalc);

  root.replaceChildren(
    page_title("退職金", "退職所得の税額と手取り"),
    form,
    result_area,
  );
  recalc();
}

/** 結果・計算過程・根拠を組み立てる */
function render_result(r, input, version, saishu_kakunin_bi) {
  const kojo_setting = version["退職所得控除"];
  const juminzei_setting = version["住民税"];

  const kinzoku_note =
    input.kinzoku_months > 0
      ? `${input.kinzoku_years}年${input.kinzoku_months}か月 → 1年未満を1年に切り上げ`
      : "1年未満の端数なし";

  const kojo_shiki =
    r.kinzoku_nensu <= kojo_setting["基礎額に達する勤続年数"]
      ? `${format_en(kojo_setting["勤続20年以下の1年あたりの金額"])} × ${r.kinzoku_nensu}年`
      : `${format_en(kojo_setting["勤続20年超の基礎額"])} ＋ ${format_en(
          kojo_setting["勤続20年超の1年あたりの金額"],
        )} ×（${r.kinzoku_nensu}年 − ${kojo_setting["基礎額に達する勤続年数"]}年）`;
  const kojo_note = [
    kojo_shiki,
    input.is_shogai ? `障害退職の加算 ${format_en(kojo_setting["障害退職の加算額"])}` : null,
  ]
    .filter(Boolean)
    .join(" ／ ");

  let kazei_note;
  if (r.kubun === "特定役員退職手当等") {
    kazei_note = "特定役員退職手当等のため2分の1を適用しない ／ 1,000円未満切捨て";
  } else if (r.kubun === "短期退職手当等") {
    const joge = version["短期退職手当等"]["2分の1が適用される残額の上限"];
    kazei_note =
      r.zangaku <= joge
        ? "短期退職手当等（残額が上限以下のため2分の1）／ 1,000円未満切捨て"
        : `短期退職手当等（${format_en(
            version["短期退職手当等"]["上限を超える場合の定額部分"],
          )} ＋ 残額 − ${format_en(joge)}）／ 1,000円未満切捨て`;
  } else {
    kazei_note = "2分の1 ／ 1,000円未満切捨て";
  }

  const steps = [
    { label: "勤続年数", value: `${r.kinzoku_nensu}年`, note: kinzoku_note },
    { label: "退職所得控除額", value: format_en(r.kojo), note: kojo_note },
    {
      label: "退職金 − 退職所得控除額",
      value: format_en(r.zangaku),
      note: r.zangaku === 0 ? "控除額が退職金を上回るため0円" : null,
    },
    { label: "課税退職所得金額", value: format_en(r.kazei_gaku), note: kazei_note },
    {
      label: "所得税及び復興特別所得税",
      value: format_en(r.shotokuzei),
      note: r.is_teishutsu
        ? "速算表による所得税 × 102.1% ／ 1円未満切捨て"
        : "受給に関する申告書の提出がないため 退職金の額 × 20.42% ／ 1円未満切捨て",
    },
    {
      label: "住民税",
      value: format_en(r.juminzei.gokei),
      note:
        `市町村民税 ${format_en(r.juminzei.shichoson)}（${juminzei_setting["市町村民税の税率パーセント"]}%）` +
        ` ＋ 道府県民税 ${format_en(r.juminzei.dofuken)}（${juminzei_setting["道府県民税の税率パーセント"]}%）` +
        " ／ それぞれ100円未満切捨て",
    },
  ];

  const blocks = [
    result_card("手取額（概算）", format_en(r.tegaki), [
      { label: "所得税及び復興特別所得税", value: format_en(r.shotokuzei) },
      { label: "住民税", value: format_en(r.juminzei.gokei) },
      { label: "区分", value: r.kubun },
    ]),
    breakdown(steps),
  ];

  if (!r.is_teishutsu) {
    blocks.push(
      note_block("この計算について", [
        "「退職所得の受給に関する申告書」の提出がないため、所得税は退職金の額に一律20.42%を乗じた源泉徴収額です。退職所得控除額や2分の1は反映されません。",
        "本人が確定申告をすることで精算されます。",
        "住民税は申告書の提出の有無にかかわらず、上記のとおり特別徴収されます。",
      ]),
    );
  }

  blocks.push(
    note_block("このツールでは扱わないもの（要相談）", [
      "死亡による退職金（相続税の対象となるため、この計算には乗りません）",
      "役員等としての期間とそれ以外の期間が混在する退職金の按分",
      "その年の前年以前に他の退職金を受けている場合の退職所得控除額の調整",
      "同じ年に2か所以上から退職金を受ける場合",
    ]),
    note_block("根拠", [
      `適用年分：${format_nenbun(input.nen)}（収録している版：${r.tekiyo_nenbun_hyoji}）`,
      "所得税法30条・89条・201条、所得税法施行令69条・71条",
      "復興財源確保法13条・28条（復興特別所得税2.1%）",
      "地方税法328条の3・50条の4（分離課税に係る所得割）",
      `数値の最終確認日：${format_hizuke(saishu_kakunin_bi)}`,
    ]),
  );

  return blocks;
}

// ---------------------------------------------------------------- 減価償却画面

async function render_genka_shokyaku() {
  back_link.hidden = false;
  root.replaceChildren(message_box("読み込んでいます…"));

  let tables;
  try {
    tables = await load_genka_shokyaku_tables();
  } catch {
    root.replaceChildren(
      page_title("減価償却費"),
      message_box(
        "償却率表を読み込めませんでした。通信できる場所で一度開くと、以後は電波がなくても使えます。",
      ),
    );
    return;
  }

  const now = new Date();
  const saitan_nen = Number(
    tables.shokyakuritsu["表"]["定額法"]["適用開始日"].slice(0, 4),
  );

  const nen_options = [];
  for (let y = now.getFullYear() + 1; y >= saitan_nen; y--) {
    nen_options.push({ value: y, label: format_nen(y) });
  }
  const tsuki_options = [];
  for (let m = 1; m <= 12; m++) tsuki_options.push({ value: m, label: `${m}月` });

  const in_kagaku = money_input({ placeholder: "0" });
  const in_shutoku_nen = select_input(nen_options, now.getFullYear());
  const in_shutoku_tsuki = select_input(tsuki_options, now.getMonth() + 1);
  const in_kessan = select_input(tsuki_options, 3);
  const in_nensu = number_input({ min: 2, max: 100, placeholder: "0" });
  const in_hoho = select_input(
    [
      { value: "定額法", label: "定額法" },
      { value: "定率法", label: "定率法" },
    ],
    "定額法",
  );
  const in_chuko = check_input(
    "中古資産として取得した",
    "簡便法で耐用年数を計算します（耐用年数省令3条1項2号）",
  );
  const in_keika_nen = number_input({ min: 0, max: 100, placeholder: "0" });
  const in_keika_tsuki = number_input({ min: 0, max: 11, placeholder: "0" });

  const hoho_warn = h("div", {});
  const chuko_field = h("div", { hidden: true },
    h("div", { class: "field-row" },
      field("経過年数（年）", in_keika_nen),
      field("うち端数（か月）", in_keika_tsuki),
    ),
  );
  const result_area = h("div", { class: "result-area" });

  const form = h("section", { class: "form" },
    field("取得価額（円）", in_kagaku, "付随費用を含めた金額。消費税は経理方式に合わせる"),
    h("div", { class: "field-row" },
      field("取得した年", in_shutoku_nen),
      field("取得した月", in_shutoku_tsuki, "事業の用に供した月と同じとみなします"),
    ),
    field("決算月", in_kessan, "事業年度は12か月として計算します。個人は12月"),
    field("耐用年数（年）", in_nensu, "中古資産のときは法定耐用年数を入れる"),
    field("償却方法", in_hoho),
    hoho_warn,
    in_chuko,
    chuko_field,
  );

  function recalc() {
    // 定率法を選べない資産があることは、画面の下ではなく選択欄の直下で知らせる
    hoho_warn.replaceChildren(
      in_hoho.value === "定率法"
        ? warn_line(
            "建物、および平成28年4月1日以後に取得した建物附属設備・構築物は、定率法を選べません（法人税法施行令48条の2）。",
          )
        : "",
    );
    chuko_field.hidden = !in_chuko.input.checked;

    const input = {
      shutoku_kagaku: Number(String(in_kagaku.value).replace(/[^0-9]/g, "") || 0),
      shutoku_year: Number(in_shutoku_nen.value),
      shutoku_month: Number(in_shutoku_tsuki.value),
      kessan_month: Number(in_kessan.value),
      taiyo_nensu: Number(in_nensu.value || 0),
      hoho: in_hoho.value,
      is_chuko: in_chuko.input.checked,
      keika_years: Number(in_keika_nen.value || 0),
      keika_months: Number(in_keika_tsuki.value || 0),
    };

    if (input.shutoku_kagaku <= 0 || input.taiyo_nensu <= 0) {
      result_area.replaceChildren(
        message_box("取得価額と耐用年数を入力してください。"),
      );
      return;
    }

    show_result(result_area, () => {
      const r = calc_genka_shokyaku(input, tables);
      return r.ok ? render_shokyaku_result(r, input, tables) : message_box(r.riyu);
    });
  }

  for (const el of [
    in_kagaku,
    in_shutoku_nen,
    in_shutoku_tsuki,
    in_kessan,
    in_nensu,
    in_hoho,
    in_keika_nen,
    in_keika_tsuki,
  ]) {
    el.addEventListener("input", recalc);
    el.addEventListener("change", recalc);
  }
  in_chuko.input.addEventListener("change", recalc);

  root.replaceChildren(
    page_title("減価償却費", "定額法・定率法"),
    form,
    result_area,
  );
  recalc();
}

/** 減価償却の結果・計算過程・根拠を組み立てる */
function render_shokyaku_result(r, input, tables) {
  const teiritsu = r.hoho === "定率法";
  const bairitsu = r.ritsu_key === "定率法250" ? "250%" : "200%";

  const steps = [
    {
      label: "耐用年数",
      value: `${r.taiyo_nensu}年`,
      note: r.chuko_note ?? "入力された年数",
    },
    {
      label: "償却率",
      value: format_ritsu(r.shokyakuritsu, 3),
      note: teiritsu ? `${bairitsu}定率法（${r.ritsu_hyodai.trim()}）` : r.ritsu_hyodai.trim(),
    },
    {
      label: "初年度の供用月数",
      value: `${r.kyoyo_tsukisu}か月`,
      note:
        r.kyoyo_tsukisu === 12
          ? "期首から事業の用に供している"
          : "事業の用に供した月から期末までを月割り（1月未満は1月）",
    },
  ];

  if (teiritsu && r.hoshoritsu !== null) {
    steps.push({
      label: "償却保証額",
      value: format_en(r.hosho_gaku),
      note:
        `取得価額 × 保証率 ${format_ritsu(r.hoshoritsu, 5)}。` +
        `期首簿価 × 償却率がこれを下回った年度から、` +
        `改定償却率 ${format_ritsu(r.kaitei_shokyakuritsu, 3)} で毎年同額を償却する`,
    });
  }

  steps.push({
    label: "初年度の償却限度額",
    value: format_en(r.shonendo),
    note: "1円未満切捨て",
  });

  const blocks = [
    result_card("初年度の償却費", format_en(r.shonendo), [
      { label: "償却方法", value: teiritsu ? `定率法（${bairitsu}）` : "定額法" },
      { label: "耐用年数", value: `${r.taiyo_nensu}年` },
      { label: "償却しきるまで", value: `${r.schedule.length}年度` },
    ]),
  ];

  if (r.shogaku.length > 0) {
    blocks.push(
      note_block("そもそも償却しないで済む可能性があります", [
        ...r.shogaku.map((s) => `${s.名称}（${s.根拠}）`),
        "いずれも要件の確認が必要です。とくに貸付け（主要な事業として行うものを除く）の用に供する資産は対象外です。",
        "中小企業者等の特例は、青色申告・中小企業者等に該当すること・1事業年度あたりの限度額の確認が必要です。",
        `判定に用いたのは「${r.shogaku_version_hyoji}」の基準です。取得価額は消費税の経理方式（税抜・税込）によって変わります。`,
      ]),
    );
  }

  blocks.push(
    breakdown(steps),
    schedule_table(
      "償却のスケジュール",
      r.schedule.map((row) => ({
        year: row["年目"],
        note: row["摘要"],
        amount: format_en(row["償却限度額"]),
        balance: format_en(row["期末簿価"]),
      })),
    ),
  );

  if (input.is_chuko) {
    blocks.push(
      note_block("中古資産の簡便法を使う前に確認すること", [
        "簡便法は、その資産を使用可能期間の見積りによることが困難な場合の方法です。",
        "その資産を事業の用に供するために支出した資本的支出の額が取得価額の50%を超えるときは、簡便法を使えません（耐用年数省令3条1項ただし書）。",
        "事業の用に供した事業年度に耐用年数の見積り等をしなかった資産について、後の年度から簡便法に変えることはできません。すでに法定耐用年数で償却を始めた資産の再計算には使わないでください。",
      ]),
    );
  }

  blocks.push(
    note_block("このツールでは扱わないもの（要相談）", [
      "平成19年3月31日以前に取得した資産（旧定額法・旧定率法）",
      "生産高比例法・リース期間定額法・取替法",
      "資本的支出・圧縮記帳・特別償却・割増償却・耐用年数の短縮",
      "事業年度が12か月でない場合（新設法人・決算期の変更）",
      "取得した月と事業の用に供した月が異なる場合",
      "耐用年数そのものの判定（耐用年数省令の別表第一〜第六で確認してください）",
      "個人事業者は償却が強制されます。また法定償却方法は定額法で、定率法によるには選定の届出が必要です（所得税法施行令125条）。",
    ]),
    note_block("根拠", [
      `償却率：${r.ritsu_hyodai.trim()}（${tables.shokyakuritsu["出典"]["法令名"]}）`,
      "法人税法施行令48条の2（定額法・定率法）・59条（期中供用の月割）・61条（備忘価額1円）",
      "法人税法施行令133条・133条の2、租税特別措置法67条の5（少額の減価償却資産）",
      "耐用年数省令3条（中古資産の耐用年数）",
      `償却率表の取得日：${format_hizuke(tables.shokyakuritsu["取得日"])}（${tables.shokyakuritsu["出典"]["最終改正"]}）`,
      `その他の数値の最終確認日：${format_hizuke(tables.genka_shokyaku["最終確認日"])}`,
    ]),
  );

  return blocks;
}

// ------------------------------------------------------------------ 印紙税画面

/** 端末の今日を "YYYY-MM-DD" で返す。toISOString は UTC になるため使わない */
function today_iso() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function render_inshizei() {
  back_link.hidden = false;
  root.replaceChildren(message_box("読み込んでいます…"));

  let tables;
  try {
    tables = await load_inshizei_tables();
  } catch {
    root.replaceChildren(
      page_title("印紙税"),
      message_box(
        "税額表を読み込めませんでした。通信できる場所で一度開くと、以後は電波がなくても使えます。",
      ),
    );
    return;
  }

  const in_bi = date_input(today_iso());
  const in_shurui = select_input(
    tables.inshizei["文書"].map((b) => ({ value: b.key, label: b["表示名"] })),
    "1",
  );
  // 見出しと補足は選んだ号に合わせて書き換えるので、要素の参照を持っておく。
  // check_input / field は note が空だと補足の要素自体を作らないため、必ず中身のある文字列で作る。
  const in_kingaku = money_input({ placeholder: "0" });
  const in_nashi = check_input("記載金額がない", "記載金額のない文書として判定します");
  const in_keigen = check_input("軽減の対象となる文書である", "対象は条文で確認してください");

  const kingaku_field_el = field("記載金額（円）", in_kingaku, "―");
  const kingaku_label = kingaku_field_el.querySelector(".field__label");
  const kingaku_note = kingaku_field_el.querySelector(".field__note");
  const keigen_label = in_keigen.querySelector(".check__label");
  const keigen_note = in_keigen.querySelector(".check__note");
  const nashi_label = in_nashi.querySelector(".check__label");

  const shurui_warn = h("div", {});
  const keigen_field = h("div", { hidden: true }, in_keigen);
  const kingaku_field = h("div", { hidden: true }, kingaku_field_el, in_nashi);
  const result_area = h("div", { class: "result-area" });

  const form = h("section", { class: "form" },
    field("文書を作成した年月日", in_bi, "軽減措置が使えるかどうかは、この日で決まります"),
    field("文書の種類", in_shurui, "どの号に当たるかの判定はこのツールでは行いません"),
    shurui_warn,
    keigen_field,
    kingaku_field,
  );

  /** 選んだ号に合わせて、出す入力欄と文言を組み替える */
  function apply_shurui() {
    const bunsho = pick_bunsho(tables.inshizei, in_shurui.value);
    const setting = nyuryoku_setting(bunsho, tables.inshizei_hyo);

    shurui_warn.replaceChildren(bunsho["注意"] ? warn_line(bunsho["注意"]) : "");

    // 軽減の対象でない号に切り替えたらチェックを外す（前の号のチェックが残ると誤った税額になる）
    const keigen_ari = bunsho["軽減"] !== null;
    if (!keigen_ari) in_keigen.input.checked = false;
    keigen_field.hidden = !keigen_ari;
    if (keigen_ari) {
      keigen_label.textContent = bunsho["軽減のチェック文言"];
      keigen_note.textContent = bunsho["軽減のチェック補足"];
    }

    kingaku_field.hidden = !setting["金額を使う"];
    if (setting["金額を使う"]) {
      kingaku_label.textContent = `${setting["金額の呼称"]}（円）`;
      kingaku_note.textContent = bunsho["金額欄の補足"] ?? "";
      kingaku_note.hidden = !bunsho["金額欄の補足"];
      nashi_label.textContent = `${setting["金額の呼称"]}の記載がない`;
    } else {
      in_nashi.input.checked = false;
    }
    in_kingaku.disabled = in_nashi.input.checked;
  }

  function recalc() {
    show_result(result_area, () => {
      apply_shurui();
      const input = {
        sakusei_bi: in_bi.value,
        key: in_shurui.value,
        kingaku: Number(String(in_kingaku.value).replace(/[^0-9]/g, "") || 0),
        kingaku_nashi: in_nashi.input.checked,
        keigen_taisho: in_keigen.input.checked,
      };
      const r = calc_inshizei(input, tables);
      return r.ok ? render_inshizei_result(r, input, tables) : message_box(r.riyu);
    });
  }

  for (const el of [in_bi, in_shurui, in_kingaku]) {
    el.addEventListener("input", recalc);
    el.addEventListener("change", recalc);
  }
  in_nashi.input.addEventListener("change", recalc);
  in_keigen.input.addEventListener("change", recalc);

  root.replaceChildren(
    page_title("印紙税", "契約書等に貼る収入印紙の額"),
    form,
    result_area,
  );
  recalc();
}

/** 区分の1行を「1,000万円超 5,000万円以下」のように表す */
function kubun_hyoji(gyo) {
  if (gyo["下限超"] === null) return `${format_en(gyo["上限以下"])}以下`;
  if (gyo["上限以下"] === null) return `${format_en(gyo["下限超"])}超`;
  return `${format_en(gyo["下限超"])}超 ${format_en(gyo["上限以下"])}以下`;
}

/** 印紙税の結果・計算過程・根拠を組み立てる */
function render_inshizei_result(r, input, tables) {
  const sakusei_bi = input.sakusei_bi;
  const blocks = [];

  if (r.keigen_kigen_gire) {
    blocks.push(
      warn_line(
        `軽減措置は${format_hizuke(r.keigen["適用終了日"])}までです。` +
          "この日より後に作成された文書のため本則で計算しました。" +
          "延長されている場合は税額表の差し替えが必要です。",
      ),
    );
  }

  blocks.push(
    result_card(
      r.hikazei ? "印紙税" : `印紙税額（${r.tani}につき）`,
      r.hikazei ? "非課税" : format_en(r.zeigaku),
      [
        { label: "文書の種類", value: `第${r.gou["号"]}号` },
        { label: "適用する税率", value: r.tekiyo },
        { label: "作成年月日", value: format_hizuke(sakusei_bi) },
      ],
    ),
  );

  const steps = [
    {
      label: "作成年月日",
      value: format_hizuke(sakusei_bi),
      note:
        r.tekiyo === "軽減"
          ? `軽減措置の適用期間内（${format_hizuke(r.keigen["適用開始日"])}から${format_hizuke(r.keigen["適用終了日"])}まで）`
          : "本則の税率で計算しました",
    },
    {
      label: "文書の種類",
      value: `第${r.gou["号"]}号`,
      note: r.kubun["見出し"] ?? r.bunsho["表示名"],
    },
  ];

  if (r.kingaku_wo_tsukau) {
    steps.push({
      label: r.kingaku_no_yobisho,
      value: input.kingaku_nashi ? "記載なし" : format_en(input.kingaku),
      note: input.kingaku_nashi
        ? "記載金額のない文書として判定しました"
        : "消費税額等が区分記載されているときは、消費税額等を含めない金額です",
    });
  }

  if (r.hikazei) {
    steps.push({
      label: "非課税の判定",
      value: "非課税",
      note: r.hikazei_riyu,
    });
  } else if (r.atehameta_gyo) {
    steps.push({
      label: "該当する区分",
      value: kubun_hyoji(r.atehameta_gyo),
      note:
        r.tekiyo === "軽減"
          ? "租税特別措置法91条の軽減税率表"
          : `印紙税法 別表第一 第${r.gou["号"]}号`,
    });
  }

  steps.push({
    label: "印紙税額",
    value: r.hikazei ? "0円（非課税）" : `${format_en(r.zeigaku)}（${r.tani}につき）`,
    note: "印紙税に円未満・千円未満の端数処理はありません",
  });

  blocks.push(breakdown(steps));

  // 手元の文書と突き合わせられるよう、条文の原文をそのまま出す
  blocks.push(
    note_block(
      `課税物件（別表第一 第${r.gou["号"]}号 物件名）`,
      r.gou["物件名"].split("\n"),
    ),
  );
  if (r.gou["定義"]) {
    blocks.push(note_block("定義（同 定義の欄）", r.gou["定義"].split("\n")));
  }
  if (r.gou["非課税物件"]) {
    blocks.push(
      note_block("非課税物件（同 非課税物件の欄）", r.gou["非課税物件"].split("\n")),
    );
  }

  blocks.push(
    note_block("この計算について", tables.inshizei["共通の注記"]),
    note_block("このツールでは扱わないもの（要相談）", tables.inshizei["扱わないもの"]),
    note_block("根拠", [
      ...tables.inshizei["出典"].map((s) => s["名称"]),
      `税額表の取得日：${format_hizuke(tables.inshizei_hyo["取得日"])}（${tables.inshizei_hyo["出典"]["印紙税法"]["最終改正"]}／${tables.inshizei_hyo["出典"]["租税特別措置法"]["最終改正"]}）`,
      `その他の数値の最終確認日：${format_hizuke(tables.inshizei["最終確認日"])}`,
    ]),
  );

  return blocks;
}

// ------------------------------------------------------- 延滞税・利子税画面

async function render_entaizei() {
  back_link.hidden = false;
  root.replaceChildren(message_box("読み込んでいます…"));

  let tables;
  try {
    tables = await load_entaizei_tables();
  } catch {
    root.replaceChildren(
      page_title("延滞税・利子税"),
      message_box(
        "割合の表を読み込めませんでした。通信できる場所で一度開くと、以後は電波がなくても使えます。",
      ),
    );
    return;
  }

  const in_shurui = select_input(
    [
      { value: "延滞税", label: "延滞税（納付が遅れた）" },
      { value: "利子税", label: "利子税（申告期限の延長など）" },
    ],
    "延滞税",
  );
  const in_honzei = money_input({ placeholder: "0" });
  const in_hotei = date_input(today_iso());
  const in_kubun = select_input(
    [
      { value: "期限内", label: "期限内申告（納期限＝法定納期限）" },
      { value: "期限後", label: "期限後申告・修正申告（納期限＝提出日）" },
    ],
    "期限内",
  );
  const in_nokigen = date_input(today_iso());
  const in_kanno = date_input(today_iso());

  const hotei_field = field("法定納期限", in_hotei, "この日の翌日から日数を数えます");
  const hotei_label = hotei_field.querySelector(".field__label");
  const hotei_note = hotei_field.querySelector(".field__note");
  const kubun_field = field("申告の区分", in_kubun);
  const nokigen_field = field(
    "納期限（申告書を提出した日）",
    in_nokigen,
    "この日の翌日から2月を経過する日までは低い割合が適用されます",
  );
  const nokigen_wrap = h("div", { hidden: true }, nokigen_field);
  const result_area = h("div", { class: "result-area" });

  const form = h("section", { class: "form" },
    field("計算するもの", in_shurui),
    field("本税の額（円）", in_honzei, "1万円未満は切り捨てて計算します（国税通則法118条3項）"),
    hotei_field,
    kubun_field,
    nokigen_wrap,
    field("完納した日", in_kanno, "延滞税・利子税はこの日まで日割りで計算します"),
  );

  function recalc() {
    const is_rishi = in_shurui.value === "利子税";
    hotei_label.textContent = is_rishi ? "申告書の提出期限" : "法定納期限";
    hotei_note.textContent = is_rishi
      ? "延長後の期限ではなく、延長前の本来の提出期限を入れます"
      : "この日の翌日から日数を数えます";
    kubun_field.hidden = is_rishi;
    const is_kigengo = !is_rishi && in_kubun.value === "期限後";
    nokigen_wrap.hidden = !is_kigengo;
    if (!is_kigengo) in_nokigen.value = in_hotei.value;

    const input = {
      shurui: in_shurui.value,
      honzei: Number(String(in_honzei.value).replace(/[^0-9]/g, "") || 0),
      hotei_nokigen: in_hotei.value,
      nokigen: is_kigengo ? in_nokigen.value : in_hotei.value,
      kanno_bi: in_kanno.value,
      is_kigengo,
    };

    show_result(result_area, () => {
      const r = calc_entaizei(input, tables);
      return r.ok ? render_entaizei_result(r, input, tables) : message_box(r.riyu);
    });
  }

  for (const el of [in_shurui, in_honzei, in_hotei, in_kubun, in_nokigen, in_kanno]) {
    el.addEventListener("input", recalc);
    el.addEventListener("change", recalc);
  }

  root.replaceChildren(
    page_title("延滞税・利子税", "納付が遅れたときの附帯税"),
    form,
    result_area,
  );
  recalc();
}

/** 延滞税・利子税の結果・計算過程・根拠を組み立てる */
function render_entaizei_result(r, input, tables) {
  const blocks = [];

  if (needs_kikan_tokurei_chui(input)) {
    blocks.push(
      warn_line(
        "法定納期限から1年を経過した後に申告書を提出しています。この場合は延滞税の計算期間から一定の期間を控除できることがありますが（国税通則法61条）、このツールは控除しません。実際より過大に出ています。",
      ),
    );
  }

  blocks.push(
    result_card(
      `${r.shurui}の額`,
      format_en(r.zeigaku),
      [
        { label: "計算の基礎となる税額", value: format_en(r.kiso_zeigaku) },
        { label: "本税の額", value: format_en(input.honzei) },
      ],
    ),
  );

  if (r.riyu_zero) blocks.push(note_block("0円になる理由", [r.riyu_zero]));

  const steps = [
    {
      label: "計算の基礎となる税額",
      value: format_en(r.kiso_zeigaku),
      note: "本税の額の1万円未満を切り捨て（国税通則法118条3項）",
    },
  ];

  if (r.ni_tsuki_keika_bi) {
    steps.push({
      label: "納期限の翌日から2月を経過する日",
      value: format_hizuke(r.ni_tsuki_keika_bi),
      note:
        `納期限 ${format_hizuke(input.nokigen)} の翌日を起算日として、` +
        "応当する日の前日に満了します（国税通則法10条1項3号）",
    });
  }

  for (const k of r.kikan) {
    for (const row of k.rows) {
      steps.push({
        label: `${k["名称"]}（${row["適用年表示"]}）`,
        value: format_en(row["金額"]),
        note:
          `${format_hizuke(row["開始"])} 〜 ${format_hizuke(row["終了"])}　${row["日数"]}日 × 年${row["割合"]}%` +
          " ／ 1円未満切捨て（租税特別措置法96条2項）",
      });
    }
  }

  steps.push({
    label: `${r.shurui}の額`,
    value: format_en(r.zeigaku),
    note:
      `合計 ${format_en(r.kiritsute_mae ?? 0)} の100円未満を切り捨て。` +
      "全額が1,000円未満のときは全額を切り捨てます（国税通則法119条4項）",
  });

  blocks.push(breakdown(steps));

  blocks.push(
    note_block("この計算について", tables.entaizei["注記"].slice(0, 4)),
    note_block("このツールでは扱わないもの（要相談）", tables.entaizei["扱わないもの"]),
    note_block("根拠", [
      ...tables.entaizei["出典"].map((s) => s["名称"]),
      `年別の割合の最終確認日：${format_hizuke(tables.entaizei["最終確認日"])}`,
    ]),
  );

  return blocks;
}

// ------------------------------------------------------------ 登録免許税画面

async function render_toroku_menkyozei() {
  back_link.hidden = false;
  root.replaceChildren(message_box("読み込んでいます…"));

  let tables;
  try {
    tables = await load_toroku_menkyozei_tables();
  } catch {
    root.replaceChildren(
      page_title("登録免許税"),
      message_box(
        "税額表を読み込めませんでした。通信できる場所で一度開くと、以後は電波がなくても使えます。",
      ),
    );
    return;
  }
  const setting = tables.toroku_menkyozei;
  const hyo = tables.toroku_menkyozei_hyo;

  const in_bi = date_input(today_iso());
  const in_gou = select_input(
    hyo["号"].map((g) => ({
      value: String(g["号"]),
      label: `第${g["号"]}号　${g["見出し"].split("\n")[0].split("　").slice(1).join("　").slice(0, 20)}`,
    })),
    "1",
  );
  const in_shurui = select_group_input();
  const in_hojin = select_input(
    setting["二値定額の区分"]["選択肢"].map((o) => ({ value: o.value, label: o.label })),
    "会社",
  );
  const in_kingaku = money_input({ placeholder: "0" });
  const in_suryo = number_input({ min: 1, value: 1 });
  const in_keigen = select_input([{ value: "", label: "なし（本則で計算）" }], "");
  const in_shutoku = date_input(today_iso());

  const kingaku_field = field("課税標準（円）", in_kingaku, "―");
  const kingaku_label = kingaku_field.querySelector(".field__label");
  const kingaku_note = kingaku_field.querySelector(".field__note");
  const suryo_field = field("数量", in_suryo, "―");
  const suryo_label = suryo_field.querySelector(".field__label");
  const suryo_note = suryo_field.querySelector(".field__note");
  const hojin_field = field(setting["二値定額の区分"]["見出し"], in_hojin, setting["二値定額の区分"]["補足"]);
  const keigen_field = field("軽減の適用", in_keigen, "―");
  const keigen_note = keigen_field.querySelector(".field__note");
  const shutoku_field = field("住宅用家屋を新築・取得した日", in_shutoku, "―");
  const shutoku_note = shutoku_field.querySelector(".field__note");

  const kingaku_wrap = h("div", { hidden: true }, kingaku_field);
  const suryo_wrap = h("div", { hidden: true }, suryo_field);
  const hojin_wrap = h("div", { hidden: true }, hojin_field);
  const keigen_wrap = h("div", { hidden: true }, keigen_field);
  const shutoku_wrap = h("div", { hidden: true }, shutoku_field);
  const shurui_warn = h("div", {});
  const result_area = h("div", { class: "result-area" });

  const form = h("section", { class: "form" },
    field("登記を受ける日", in_bi, "軽減措置が使えるかどうかは、この日または新築・取得の日で決まります"),
    field("登記の区分", in_gou, "扱うのは不動産の登記と会社の商業登記だけです"),
    field("登記の種類", in_shurui, "別表第一の区分をそのまま出しています"),
    shurui_warn,
    hojin_wrap,
    kingaku_wrap,
    suryo_wrap,
    keigen_wrap,
    shutoku_wrap,
  );

  /** 選んだ号に合わせて、登記の種類の選択肢を入れ替える */
  function fill_shurui(keep) {
    const gou = hyo["号"].find((g) => String(g["号"]) === in_gou.value);
    const groups = leaf_groups(gou).map((grp) => ({
      見出し: grp["見出し"].slice(0, 30),
      options: grp["葉"].map((l) => ({
        value: l["パス"],
        // ラベルは第1段を optgroup 側に出しているので、ここは残りの階層と名称
        label: `${l["パス"].replace(/^第\d+号/, "").replace(grp["見出し"].split("　")[0], "")}　${l["名称"]}`
          .replace(/^　+/, "")
          .slice(0, 60),
      })),
    }));
    const all = groups.flatMap((g) => g.options.map((o) => o.value));
    const selected = keep && all.includes(keep) ? keep : all[0];
    in_shurui.fill(groups, selected);
    in_shurui.value = selected;
  }

  /** 選んだ登記に合わせて、出す入力欄と文言を組み替える */
  function apply_shurui() {
    const found = pick_leaf(hyo, in_shurui.value);
    if (!found) return null;
    const ha = found["葉"];
    const ritsu = ha["税率"];

    const chui = setting["葉ごとの注意"][ha["パス"]] ?? [];
    shurui_warn.replaceChildren(...chui.map((t) => warn_line(t)));

    const is_teigaku = ritsu["種別"] === "定額" || ritsu["種別"] === "二値定額";
    const is_niti = ritsu["種別"] === "二値定額";
    // 二値定額で「会社」を選んだときだけ資本金の額を聞く
    const kaisha = is_niti && in_hojin.value === "会社";
    const kingaku_iru = ritsu["種別"] === "定率" || kaisha;

    hojin_wrap.hidden = !is_niti;
    kingaku_wrap.hidden = !kingaku_iru;
    suryo_wrap.hidden = !is_teigaku;

    if (kingaku_iru) {
      kingaku_label.textContent = `${ha["課税標準"]}（円）`;
      const hosoku = setting["課税標準の補足"][ha["課税標準"]] ?? "";
      kingaku_note.textContent = hosoku;
      kingaku_note.hidden = hosoku === "";
    }
    if (is_teigaku) {
      suryo_label.textContent = ha["課税標準"];
      suryo_note.textContent =
        ha["但書"] && ha["但書"]["種別"] === "個数超過の別建て"
          ? `この計算は申請書1件分です。${ha["但書"]["原文"]}`
          : "この計算は申請書1件分です";
    }

    // 軽減。対象でない登記に切り替えたら選択を戻す（前の選択が残ると誤った税額になる）
    const kouho = keigen_for_leaf(setting, ha["パス"]);
    keigen_wrap.hidden = kouho.length === 0;
    if (kouho.length === 0) {
      in_keigen.value = "";
      shutoku_wrap.hidden = true;
    } else {
      const cur = kouho.some((k) => k["キー"] === in_keigen.value) ? in_keigen.value : "";
      in_keigen.replaceChildren(
        h("option", { value: "" }, "なし（本則で計算）"),
        ...kouho.map((k) => h("option", { value: k["キー"] }, k["選択肢の文言"])),
      );
      in_keigen.value = cur;
      const erabu = kouho.find((k) => k["キー"] === cur);
      keigen_note.textContent = erabu ? erabu["補足"] : "対象かどうかは条文で確認してください";
      const shutoku_iru = erabu?.["期間の判定日"] === "新築・取得の日";
      shutoku_wrap.hidden = !shutoku_iru;
      if (shutoku_iru) shutoku_note.textContent = erabu["1年以内の注意"];
    }
    return ha;
  }

  function recalc() {
    show_result(result_area, () => {
      const ha = apply_shurui();
      const input = {
        toki_bi: in_bi.value,
        path: in_shurui.value,
        kingaku: Number(String(in_kingaku.value).replace(/[^0-9]/g, "") || 0),
        suryo: Number(in_suryo.value || 0),
        keigen_key: in_keigen.value || null,
        shutoku_bi: shutoku_wrap.hidden ? null : in_shutoku.value,
        hojin_kubun: in_hojin.value,
      };
      const r = calc_toroku_menkyozei(input, tables);
      if (!r.ok) {
        return [
          message_box(r.riyu),
          ...(r["原文"] ? [note_block("税率欄の原文", [r["原文"]])] : []),
        ];
      }
      return render_toroku_result(r, input, tables, ha);
    });
  }

  in_gou.addEventListener("change", () => {
    fill_shurui(null);
    recalc();
  });
  for (const el of [in_bi, in_shurui, in_hojin, in_kingaku, in_suryo, in_keigen, in_shutoku]) {
    el.addEventListener("input", recalc);
    el.addEventListener("change", recalc);
  }

  fill_shurui(null);
  root.replaceChildren(
    page_title("登録免許税", "不動産の登記と会社の商業登記"),
    form,
    result_area,
  );
  recalc();
}

/** 「千分の四（4/1000）」のように税率を表す */
function ritsu_hyoji(ritsu) {
  return `${ritsu["原文"]}（${ritsu["分子"]}/${ritsu["分母"]}）`;
}

/** 軽減が効かなかったときの1行 */
function keigen_keikoku_bun(w) {
  if (w["種別"] === "期限後") {
    return (
      `${w["根拠"]}の軽減は${format_hizuke(w["適用終了日"])}までです。` +
      "この日より後のため本則で計算しました。延長されている場合は税額表の差し替えが必要です。"
    );
  }
  if (w["種別"] === "開始前") {
    return `${w["根拠"]}の軽減は${format_hizuke(w["適用開始日"])}からです。本則で計算しました。`;
  }
  return `${w["根拠"]}の軽減は判定できませんでした。${w["理由"] ?? ""}`;
}

/** 登録免許税の結果・計算過程・根拠を組み立てる */
function render_toroku_result(r, input, tables, ha) {
  const setting = tables.toroku_menkyozei;
  const hyo = tables.toroku_menkyozei_hyo;
  const blocks = [];

  if (r["軽減の警告"]) blocks.push(warn_line(keigen_keikoku_bun(r["軽減の警告"])));
  if (r["一年の警告"]) blocks.push(warn_line(r["一年の警告"]));

  blocks.push(
    result_card("登録免許税額", format_en(r["税額"]), [
      { label: "登記の種類", value: `${r["葉"]["パス"]}` },
      {
        label: "適用する税率",
        value: r["種別"] === "定率" ? `${r["適用"]}　${ritsu_hyoji(r["税率"])}` : r["葉"]["税率"]["原文"],
      },
      { label: "登記を受ける日", value: format_hizuke(input.toki_bi) },
    ]),
  );

  const steps = [
    {
      label: "登記の種類",
      value: r["葉"]["パス"],
      note: r["葉"]["名称"],
    },
  ];

  if (r["種別"] === "定率") {
    steps.push({
      label: r["葉"]["課税標準"],
      value: format_en(r["課税標準"]),
      note: r["課税標準を千円にした"]
        ? `入力額 ${format_en(input.kingaku)} は全額が千円未満のため千円とします（登録免許税法15条）`
        : `入力額 ${format_en(input.kingaku)} の千円未満を切り捨て（国税通則法118条1項）`,
    });
    if (r["適用"] === "軽減") {
      steps.push({
        label: "適用する軽減",
        value: r["軽減"]["根拠"],
        note:
          `${format_hizuke(r["軽減の定義"]["適用開始日"])}から${format_hizuke(r["軽減の定義"]["適用終了日"])}まで` +
          `／${r["軽減"]["期間の判定日"]}（${format_hizuke(r["軽減の判定日"])}）で判定`,
      });
    }
    steps.push({
      label: "税率",
      value: ritsu_hyoji(r["税率"]),
      note: r["適用"] === "軽減" ? "租税特別措置法の軽減税率" : "登録免許税法 別表第一の税率",
    });
    steps.push({
      label: "税額",
      value: format_en(r["百円未満切捨て後"]),
      note:
        `${format_number(r["課税標準"])} × ${r["税率"]["分子"]}/${r["税率"]["分母"]} = ` +
        `${format_number(r["計算額"])}円 の百円未満を切り捨て（国税通則法119条1項）`,
    });
    if (r["最低税額の適用"] === "但書") {
      steps.push({
        label: "最低税額",
        value: format_en(r["税額"]),
        note: r["葉"]["但書"]["原文"],
      });
    } else if (r["最低税額の適用"] === "登免法19条") {
      steps.push({
        label: "最低税額",
        value: format_en(r["税額"]),
        note: "税率を適用して計算した金額が千円に満たないため千円とします（登録免許税法19条）",
      });
    }
  } else {
    if (r["区分の理由"]) {
      steps.push({
        label: setting["二値定額の区分"]["見出し"],
        value: setting["二値定額の区分"]["選択肢"].find((o) => o.value === input.hojin_kubun)?.label ?? "―",
        note: r["区分の理由"],
      });
    }
    steps.push({
      label: "単価",
      value: `${format_en(r["単価"])}（${r["葉"]["税率"]["単位"]}につき）`,
      note: r["葉"]["税率"]["原文"],
    });
    steps.push({
      label: r["葉"]["課税標準"],
      value: `${format_number(r["数量"])}`,
      note: "この計算は申請書1件分です",
    });
    if (r["但書の適用"]) {
      steps.push({
        label: "但書の適用",
        value: format_en(r["税額"]),
        note: `${r["但書の適用"]["原文"]}　※最低税額ではなく別建ての額のため、単価×数量ではなくこの額になります`,
      });
    } else {
      steps.push({
        label: "税額",
        value: format_en(r["税額"]),
        note: `${format_number(r["単価"])} × ${format_number(r["数量"])}　定額課税に端数処理はありません`,
      });
    }
  }

  blocks.push(breakdown(steps));

  // 手元の登記と突き合わせられるよう、別表の原文をそのまま出す
  blocks.push(
    note_block(`別表第一 ${r["葉"]["パス"]}`, [
      r["葉"]["名称"],
      `課税標準：${r["葉"]["課税標準"]}`,
      `税率：${r["葉"]["税率"]["原文"]}`,
      ...(r["葉"]["但書"] ? [`但書：${r["葉"]["但書"]["原文"]}`] : []),
    ]),
    note_block(`第${r["号"]["号"]}号の範囲`, r["号"]["見出し"].split("\n")),
  );

  blocks.push(
    note_block("この計算について", setting["共通の注記"]),
    note_block("このツールでは扱わないもの（要相談）", setting["扱わないもの"]),
    note_block("根拠", [
      ...setting["出典"].map((s) => s["名称"]),
      `税額表の取得日：${format_hizuke(hyo["取得日"])}（${hyo["出典"]["登録免許税法"]["最終改正"]}／${hyo["出典"]["租税特別措置法"]["最終改正"]}）`,
      `その他の文言の最終確認日：${format_hizuke(setting["最終確認日"])}`,
    ]),
  );

  return blocks;
}

// -------------------------------------------------------- 法人税の早見表画面

/** 直近の4月1日。事業年度開始日は過去の日付なので、今日を既定にすると誤入力になりやすい */
function chokkin_no_shigatsu_ichinichi() {
  const d = new Date();
  const y = d.getMonth() + 1 >= 4 ? d.getFullYear() : d.getFullYear() - 1;
  return `${y}-04-01`;
}

async function render_hojinzei_hayami() {
  back_link.hidden = false;
  root.replaceChildren(message_box("読み込んでいます…"));

  let data;
  try {
    data = await load_hojinzei_hayami();
  } catch {
    root.replaceChildren(
      page_title("法人税の早見表"),
      message_box(
        "率の表を読み込めませんでした。通信できる場所で一度開くと、以後は電波がなくても使えます。",
      ),
    );
    return;
  }

  const in_bi = date_input(chokkin_no_shigatsu_ichinichi());
  const result_area = h("div", { class: "result-area" });

  function recalc() {
    show_result(result_area, () => render_hayami(data, in_bi.value));
  }
  in_bi.addEventListener("input", recalc);
  in_bi.addEventListener("change", recalc);

  root.replaceChildren(
    page_title("法人税の早見表", "資本金1億円以下の普通法人・標準税率"),
    h("section", { class: "form" },
      field("事業年度開始日", in_bi, "軽減税率が使えるかどうかは、この日で決まります"),
    ),
    result_area,
  );
  recalc();
}

/** 早見表の中身を組み立てる */
function render_hayami(data, kaishi_bi) {
  const r = build_zeigaku_hyo(data, kaishi_bi);
  if (!r.ok) return message_box(r.riyu);

  const kinto = build_kintowari_hyo(data);
  const jikko = horitsu_jikko_zeiritsu(data);
  const blocks = [];

  if (r["軽減の期限切れ"]) {
    blocks.push(
      warn_line(
        `中小法人の軽減税率の特例（租税特別措置法42条の3の2）は、${format_hizuke(r["軽減の適用終了日"])}までに開始する事業年度までです。` +
          "この表は本則の19%で組みました。延長されている場合は率の表の差し替えが必要です。",
      ),
    );
  }

  // ---- 表1 所得規模別の納税額と負担率
  blocks.push(
    h("section", { class: "block" },
      h("h2", { class: "block__title" }, "所得規模別の納税額と負担率"),
      h("p", { class: "block__lead" },
        `事業年度開始日 ${format_hizuke(kaishi_bi)}　／　均等割は含みません`,
      ),
      h("div", { class: "hayami" },
        r["行"].map((g) =>
          h("div", { class: "hayami__card" },
            h("div", { class: "hayami__head" },
              h("span", { class: "hayami__shotoku" }, `所得 ${format_en(g["所得"])}`),
              h("span", { class: "hayami__ritsu" }, `${(g["負担率"] * 100).toFixed(1)}%`),
            ),
            h("dl", { class: "hayami__uchiwake" },
              [
                ["法人税", g["法人税"]],
                ["地方法人税", g["地方法人税"]],
                ["住民税 法人税割", g["住民税法人税割"]],
                ["事業税", g["事業税"]],
                ["特別法人事業税", g["特別法人事業税"]],
              ].flatMap(([label, v]) => [
                h("dt", {}, label),
                h("dd", {}, format_en(v)),
              ]),
            ),
            h("p", { class: "hayami__gokei" },
              h("span", {}, "合計"),
              h("strong", {}, format_en(g["合計"])),
            ),
          ),
        ),
      ),
    ),
  );

  blocks.push(
    note_block("法定実効税率（会計の税効果で使う率）", [
      `${(jikko * 100).toFixed(2)}%（本則。法人税23.2%・事業税7.0%で計算）`,
      "式：（法人税率 ×（1 ＋ 地方法人税率 ＋ 住民税法人税割率）＋ 事業税率 ×（1 ＋ 特別法人事業税率））÷（1 ＋ 事業税率 ×（1 ＋ 特別法人事業税率））",
      "年800万円以下の部分は軽減税率が効くため、上の表の負担率はこれより低く出ます。",
    ]),
  );

  // ---- 表2 均等割
  const kinto_gyo = (title, kubun, with_juugyoin) =>
    h("div", { class: "kinto" },
      h("h3", { class: "kinto__title" }, title),
      h("table", { class: "schedule" },
        h("thead", {},
          h("tr", {},
            h("th", { class: "schedule__th" }, "資本金等の額"),
            with_juugyoin && h("th", { class: "schedule__th" }, "従業者数"),
            h("th", { class: "schedule__th schedule__th--num" }, "年額"),
          ),
        ),
        h("tbody", {},
          kubun.map((k) =>
            h("tr", {},
              h("td", { class: "schedule__year" }, k["資本金等の額"]),
              with_juugyoin && h("td", { class: "schedule__year" }, k["従業者数"]),
              h("td", { class: "schedule__num" }, format_en(k["税額"])),
            ),
          ),
        ),
      ),
    );

  const saitei = kinto["赤字でも出る最低額"];
  blocks.push(
    h("section", { class: "block" },
      h("h2", { class: "block__title" }, "均等割（赤字でも課されます）"),
      result_card("最低でも年間", format_en(saitei["合計"]), [
        { label: "道府県民税", value: format_en(saitei["道府県民税"]) },
        { label: "市町村民税", value: format_en(saitei["市町村民税"]) },
      ]),
      h("p", { class: "block__lead" }, saitei["説明"]),
      kinto_gyo("道府県民税（地方税法52条1項）", kinto["道府県民税"]["区分"], false),
      kinto_gyo("市町村民税（地方税法312条1項）", kinto["市町村民税"]["区分"], true),
    ),
  );

  blocks.push(
    note_block("均等割の区分の見かた", [
      ...kinto["判定の注意"],
      kinto["市町村民税"]["非対称の注意"],
    ]),
    note_block("この表について", data["共通の注記"]),
    note_block("このツールでは扱わないもの（要相談）", data["扱わないもの"]),
    note_block("根拠", [
      ...data["出典"].map((s) => s["名称"]),
      `率の最終確認日：${format_hizuke(data["最終確認日"])}`,
      `収録開始日：${format_hizuke(data["収録開始日"])}（${data["収録開始日の理由"]}）`,
    ]),
  );

  return blocks;
}

// ------------------------------------------------------------ 和暦・西暦画面

/** 「令和8年」「令和元年」のように、元号年を1年は「元」で表す */
function nengo_hyoji(mei, nen) {
  return `${mei}${nen === 1 ? "元" : nen}年`;
}

async function render_gengo() {
  back_link.hidden = false;
  root.replaceChildren(message_box("読み込んでいます…"));

  let data;
  try {
    data = await load_gengo();
  } catch {
    root.replaceChildren(
      page_title("和暦・西暦"),
      message_box(
        "元号早見表を読み込めませんでした。通信できる場所で一度開くと、以後は電波がなくても使えます。",
      ),
    );
    return;
  }

  const list = data["元号一覧"];
  const this_year = new Date().getFullYear();

  // 開いた時点の元号・元号年を既定値にする（見本アプリの「今日」相当）
  const kyou = gengo_from_seireki(this_year, list, this_year);
  const kyou_kouho = kyou.ok ? kyou.kouho[kyou.kouho.length - 1] : null;

  const in_muki = select_input(
    [
      { value: "wareki", label: "和暦から変換" },
      { value: "seireki", label: "西暦から変換" },
    ],
    "wareki",
  );
  const in_mei = select_input(
    [...list].reverse().map((g) => ({ value: g["名称"], label: g["名称"] })),
    kyou_kouho?.mei ?? "令和",
  );
  const in_gengo_nen = number_input({ min: 1, value: kyou_kouho?.gengo_nen ?? "" });
  const in_seireki = number_input({ min: list[0]["開始西暦年"], value: this_year });

  const wareki_field = h("div", { class: "field-row" },
    field("元号", in_mei),
    field("年", in_gengo_nen),
  );
  const seireki_field = field("西暦（年）", in_seireki);
  const seireki_wrap = h("div", { hidden: true }, seireki_field);
  const result_area = h("div", { class: "result-area" });

  const form = h("section", { class: "form" },
    field("変換の方向", in_muki),
    wareki_field,
    seireki_wrap,
  );

  function recalc() {
    const is_seireki = in_muki.value === "seireki";
    wareki_field.hidden = is_seireki;
    seireki_wrap.hidden = !is_seireki;

    if (is_seireki) {
      const seireki = Number(in_seireki.value || 0);
      if (seireki <= 0) {
        result_area.replaceChildren(message_box("西暦年を入力してください。"));
        return;
      }
      show_result(result_area, () => {
        const r = gengo_from_seireki(seireki, list, this_year);
        return r.ok
          ? render_gengo_result({ muki: "seireki", seireki, r }, data, this_year)
          : message_box(r.riyu);
      });
    } else {
      const mei = in_mei.value;
      const gengo_nen = Number(in_gengo_nen.value || 0);
      if (gengo_nen <= 0) {
        result_area.replaceChildren(message_box("元号と年を入力してください。"));
        return;
      }
      show_result(result_area, () => {
        const r = seireki_from_gengo(mei, gengo_nen, list, this_year);
        return r.ok
          ? render_gengo_result({ muki: "wareki", mei, gengo_nen, r }, data, this_year)
          : message_box(r.riyu);
      });
    }
  }

  for (const el of [in_muki, in_mei, in_gengo_nen, in_seireki]) {
    el.addEventListener("input", recalc);
    el.addEventListener("change", recalc);
  }

  root.replaceChildren(
    page_title("和暦・西暦", "和暦⇄西暦・年齢の概算（年単位）"),
    form,
    result_area,
  );
  recalc();
}

/** 和暦・西暦の結果・計算過程・根拠を組み立てる */
function render_gengo_result(input, data, this_year) {
  const r = input.r;
  const blocks = [];

  if (r.keikoku) blocks.push(warn_line(r.keikoku));

  const seireki = input.muki === "wareki" ? r.seireki : input.seireki;
  const nenrei = seireki <= this_year ? calc_nenrei_gaisan(seireki, this_year) : null;
  const nenrei_hyoji =
    nenrei?.ok && nenrei.saitei === nenrei.saiko
      ? `${nenrei.saiko}歳（概算）`
      : nenrei?.ok
        ? `満${nenrei.saitei}〜${nenrei.saiko}歳`
        : null;
  const nenrei_sub = nenrei_hyoji
    ? [{ label: "生まれ年だとすると（概算）", value: nenrei_hyoji }]
    : [];

  if (input.muki === "wareki") {
    blocks.push(
      result_card(nengo_hyoji(input.mei, input.gengo_nen), `西暦${seireki}年`, nenrei_sub),
      breakdown([
        {
          label: "西暦",
          value: `${seireki}年`,
          note: `${input.mei}の開始西暦年 ＋ ${nengo_hyoji(input.mei, input.gengo_nen)} − 1年`,
        },
      ]),
    );
  } else {
    const kouho_hyoji = r.kouho.map((k) => nengo_hyoji(k.mei, k.gengo_nen)).join("・");
    blocks.push(
      result_card(`西暦${seireki}年`, kouho_hyoji, nenrei_sub),
      breakdown(
        r.kouho.map((k) => ({
          label: k.mei,
          value: nengo_hyoji(k.mei, k.gengo_nen).replace(k.mei, ""),
          note: `${k.mei}の開始西暦年からの年数`,
        })),
      ),
    );
  }

  if (seireki > this_year) {
    blocks.push(
      note_block("年齢について", ["入力が今年より先の年のため、年齢は計算していません。"]),
    );
  }

  blocks.push(
    note_block("このツールでは扱わないもの（要相談）", [
      "月日を含む正確な変換（改元日をまたぐ月日の判定）",
      "明治5年以前の太陰太陽暦（旧暦）",
      "干支",
    ]),
    note_block("年齢の概算について", [
      "入力した年を「生まれ年」とみなした場合の、今年時点での満年齢の幅です。" +
        "誕生日を迎えているかどうかで1歳ぶれるため、単一の値ではなく幅で表示しています。",
    ]),
    note_block("根拠", [
      ...data["出典"].map((s) => s["名称"]),
      `元号一覧の最終確認日：${format_hizuke(data["最終確認日"])}`,
    ]),
  );

  return blocks;
}

// ---------------------------------------------------------------- リンク集画面

async function render_link_shu() {
  back_link.hidden = false;
  root.replaceChildren(message_box("読み込んでいます…"));

  let data;
  try {
    data = await load_link_shu();
  } catch {
    root.replaceChildren(
      page_title("リンク集"),
      message_box(
        "リンク集を読み込めませんでした。通信できる場所で一度開くと、以後は電波がなくても一覧を見られます。",
      ),
    );
    return;
  }

  root.replaceChildren(
    page_title("リンク集", "税額表・社会保険料率等"),
    // ★適用年度を必ず出す（設計原則6）。危ないのはリンク切れではなく、古いページが正常に開くこと
    ...data["分類"].map((k) =>
      h("section", { class: "block" },
        h("h2", { class: "block__title" }, k["見出し"]),
        h("div", { class: "links" },
          k["リンク"].map((l) =>
            h("a", {
              class: "link",
              href: l["url"],
              target: "_blank",
              rel: "noopener noreferrer",
            },
              h("span", { class: "link__head" },
                h("span", { class: "link__name" }, l["名称"]),
                h("span", { class: "link__year" }, l["適用年度"]),
              ),
              h("span", { class: "link__from" }, l["提供元"]),
              l["補足"] && h("span", { class: "link__note" }, l["補足"]),
            ),
          ),
        ),
      ),
    ),
    note_block("この一覧について", data["注記"]),
    // ★リンク集の最終更新日を画面に出す（設計原則6）
    h("p", { class: "updated" }, `このリンク集の最終更新日：${format_hizuke(data["最終更新日"])}`),
  );
}

// ------------------------------------------------------------ 更新の確認画面

/**
 * 改正を反映したことを知らせたとき、職員が自分の端末で照合するための画面（判断ログ D-25）。
 *
 * ★連絡手段の名前（チャットワーク・Teams 等）をこの画面に書かない。
 *   手段が変わるたびに src/ が変わり、版が上がって全端末の再配信が要るため。
 *   具体的な連絡先は手順書（docs/配布手順書.md）だけに置く。
 *
 * ★「アプリの版」と「数値表の日付」は別々の合格条件として見せる。
 *   数値表（data/*.json）は network-first なので、この画面を開いた時点で最新に入れ替わる。
 *   一方ロジック（src/ 配下）は版付き cache-first なので、次に起動し直すまで古いままでありうる（D-16）。
 *   日付だけを見せると「日付は最新なのに旧ロジックで計算している」状態を反映済みと誤読させる。
 */
async function render_koushin() {
  back_link.hidden = false;
  root.replaceChildren(message_box("読み込んでいます…"));

  // 1つ読めなくても画面は出す（電波の悪い場所で開くのが主な用途のため）
  const rows = await Promise.all(
    KOUSHIN_ICHIRAN.map(async (t) => {
      try {
        const json = await load_data(t.file);
        const hizuke = json[t.key];
        return {
          file: t.file,
          name: typeof json["名称"] === "string" ? json["名称"] : t.file,
          // 決め打ったキーが無い＝差し替えでキー名が変わった。別の日付で代用しない
          hizuke: typeof hizuke === "string" ? hizuke : null,
          yomenai: false,
        };
      } catch {
        return { file: t.file, name: t.file, hizuke: null, yomenai: true };
      }
    }),
  );

  const hizuke_cell = (r) => {
    if (r.yomenai) return "未取得";
    if (r.hizuke === null) return "日付が読めません";
    return format_hizuke(r.hizuke);
  };

  root.replaceChildren(
    page_title("更新の確認", "この端末に入っている内容"),
    h("section", { class: "block" },
      result_card("アプリの版", APP_VERSION),
      h("p", { class: "block__lead" },
        "計算のしかた（ロジック）の版です。数値表だけの改正では変わりません。",
      ),
    ),
    h("section", { class: "block" },
      h("h2", { class: "block__title" }, "数値表の日付"),
      h("table", { class: "schedule" },
        h("thead", {},
          h("tr", {},
            h("th", { class: "schedule__th" }, "数値表"),
            h("th", { class: "schedule__th schedule__th--num" }, "日付"),
          ),
        ),
        h("tbody", {},
          rows.map((r) =>
            h("tr", {},
              h("td", { class: "schedule__year" },
                h("span", {}, r.name),
                h("span", { class: "schedule__note" }, `data/${r.file}.json`),
              ),
              h("td", {
                class: r.hizuke === null ? "schedule__num schedule__num--muted" : "schedule__num",
              }, hizuke_cell(r)),
            ),
          ),
        ),
      ),
    ),
    note_block("見かた", [
      "事務所からのお知らせには、更新した数値表の名称と日付が書いてあります。同じ日付がここに出ていれば、この端末に反映されています。",
      "お知らせに「アプリの版」が書かれているときは、上の版と見比べてください。違っていたら、アプリをいったん閉じて開き直してください。",
      "「未取得」の行は、通信できる場所で一度この画面を開くと入ります。",
      "「日付が読めません」と出ているときは、数値表の差し替えでキー名が変わっている可能性があります。計算せずに事務所へ知らせてください。",
    ]),
  );
}

// ------------------------------------------------------------------ ルータ

const ROUTES = {
  "/": render_menu,
  "/taishokukin": render_taishokukin,
  "/genka-shokyaku": render_genka_shokyaku,
  "/inshizei": render_inshizei,
  "/toroku-menkyozei": render_toroku_menkyozei,
  "/entaizei": render_entaizei,
  "/gengo": render_gengo,
  "/link-shu": render_link_shu,
  "/hojinzei-hayami": render_hojinzei_hayami,
  "/koushin": render_koushin,
};

function route() {
  const path = location.hash.replace(/^#/, "") || "/";
  const render = ROUTES[path] ?? render_menu;
  window.scrollTo(0, 0);
  render();
}

window.addEventListener("hashchange", route);
route();

// service worker の登録（file:// では動かないため、失敗しても画面は使える）
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}
