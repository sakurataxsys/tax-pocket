// ハッシュルーティングと各画面の描画。
// 画面は index.html 1枚に載せる（#/taishokukin のようにハッシュで切り替える）。
// 動的 import は使わない。service worker が版ごとにまとめてキャッシュするため、
// 後から別の版のモジュールを取りに行く経路を作らない。

import {
  load_taishokukin_tables,
  load_genka_shokyaku_tables,
  load_inshizei_tables,
} from "./data.js";
import { calc_taishokukin, pick_version } from "./calc/taishokukin.js";
import { calc_genka_shokyaku } from "./calc/genka_shokyaku.js";
import { calc_inshizei, pick_bunsho, nyuryoku_setting } from "./calc/inshizei.js";
import {
  format_en,
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
  { name: "登録免許税", desc: "登記の種類・課税標準から", ready: false },
  { name: "延滞税・利子税", desc: "納付が遅れた日数から", ready: false },
];

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

    const r = calc_taishokukin(input, tables);
    if (!r.ok) {
      result_area.replaceChildren(message_box(r.riyu));
      return;
    }
    const version = pick_version(tables.taishokukin["版"], input.nen);
    result_area.replaceChildren(
      ...render_result(r, input, version, tables.taishokukin["最終確認日"]),
    );
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

    const r = calc_genka_shokyaku(input, tables);
    if (!r.ok) {
      result_area.replaceChildren(message_box(r.riyu));
      return;
    }
    result_area.replaceChildren(...render_shokyaku_result(r, input, tables));
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
    apply_shurui();
    const input = {
      sakusei_bi: in_bi.value,
      key: in_shurui.value,
      kingaku: Number(String(in_kingaku.value).replace(/[^0-9]/g, "") || 0),
      kingaku_nashi: in_nashi.input.checked,
      keigen_taisho: in_keigen.input.checked,
    };
    const r = calc_inshizei(input, tables);
    if (!r.ok) {
      result_area.replaceChildren(message_box(r.riyu));
      return;
    }
    result_area.replaceChildren(...render_inshizei_result(r, input, tables));
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

// ------------------------------------------------------------------ ルータ

const ROUTES = {
  "/": render_menu,
  "/taishokukin": render_taishokukin,
  "/genka-shokyaku": render_genka_shokyaku,
  "/inshizei": render_inshizei,
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
