// ハッシュルーティングと各画面の描画。
// 画面は index.html 1枚に載せる（#/taishokukin のようにハッシュで切り替える）。
// 動的 import は使わない。service worker が版ごとにまとめてキャッシュするため、
// 後から別の版のモジュールを取りに行く経路を作らない。

import { load_taishokukin_tables } from "./data.js";
import { calc_taishokukin, pick_version } from "./calc/taishokukin.js";
import { format_en, format_nenbun, format_hizuke } from "./format.js";
import {
  h,
  page_title,
  field,
  money_input,
  number_input,
  select_input,
  check_input,
  result_card,
  breakdown,
  note_block,
  message_box,
} from "./ui.js";

const root = document.getElementById("app");
const back_link = document.getElementById("back");

const MENU = [
  { path: "#/taishokukin", name: "退職金", desc: "退職所得の税額と手取り", ready: true },
  { name: "減価償却費", desc: "定額法・定率法", ready: false },
  { name: "印紙税", desc: "契約書等の記載金額から", ready: false },
  { name: "登録免許税", desc: "登記の種類・課税標準から", ready: false },
  { name: "延滞税・利子税", desc: "納付が遅れた日数から", ready: false },
];

// ------------------------------------------------------------ メニュー画面

function render_menu() {
  back_link.hidden = true;
  root.replaceChildren(
    page_title("税額ポケット", "客先で使う税額計算ツール"),
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

// ------------------------------------------------------------------ ルータ

const ROUTES = {
  "/": render_menu,
  "/taishokukin": render_taishokukin,
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
