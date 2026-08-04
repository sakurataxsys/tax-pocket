// 画面の型。以後のメニューはすべてこの部品の上に乗せる。
//
// 見た目の原則（グローバル CLAUDE.md の内部ツール4原則）
//   ・余白を贅沢に取る  ・白とごく薄いグレー、差し色は青1色
//   ・見出しは大きく、補足はグレーで小さく  ・罫線で囲わず、余白と薄い影で区切る
// 事務所名・ロゴ・ブランド配色は入れない（設計原則5）。

import { format_number, parse_number } from "./format.js";

/** 要素を作る小さなヘルパ */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    // innerHTML は用意しない。文字列は必ずテキストノードとして入れる（公開ツールのため）
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** 画面の見出し。lead は補足（グレー・小） */
export function page_title(title, lead) {
  return h("div", { class: "page-head" },
    h("h1", { class: "page-title" }, title),
    lead && h("p", { class: "page-lead" }, lead),
  );
}

/** 入力ひとつ分。note は入力欄の下に置く小さなグレーの補足 */
export function field(label_text, control, note) {
  const id = control.id || `f${Math.random().toString(36).slice(2, 8)}`;
  control.id = id;
  return h("div", { class: "field" },
    h("label", { class: "field__label", for: id }, label_text),
    control,
    note && h("p", { class: "field__note" }, note),
  );
}

/** 金額の入力欄。3桁区切りを入れながら、カーソル位置を保つ */
export function money_input(opts = {}) {
  const input = h("input", {
    type: "text",
    inputmode: "numeric",
    autocomplete: "off",
    class: "input input--money",
    placeholder: opts.placeholder ?? "0",
  });
  input.addEventListener("input", () => {
    const keta_before = (input.value.slice(0, input.selectionStart).match(/[0-9]/g) ?? []).length;
    const n = parse_number(input.value);
    input.value = input.value.trim() === "" ? "" : format_number(n);
    let pos = 0;
    let seen = 0;
    while (pos < input.value.length && seen < keta_before) {
      if (/[0-9]/.test(input.value[pos])) seen++;
      pos++;
    }
    input.setSelectionRange(pos, pos);
  });
  return input;
}

/** 数値（年数など）の入力欄 */
export function number_input(opts = {}) {
  return h("input", {
    type: "number",
    inputmode: "numeric",
    min: opts.min ?? 0,
    max: opts.max,
    step: 1,
    value: opts.value ?? "",
    class: "input input--number",
    placeholder: opts.placeholder ?? "0",
  });
}

/** 選択欄 */
export function select_input(options, selected) {
  return h("select", { class: "input input--select" },
    options.map((o) =>
      h("option", { value: o.value, selected: String(o.value) === String(selected) }, o.label),
    ),
  );
}

/** チェック欄（タップ範囲を広く取る） */
export function check_input(label_text, note) {
  const box = h("input", { type: "checkbox", class: "check__box" });
  const wrap = h("label", { class: "check" },
    box,
    h("span", { class: "check__body" },
      h("span", { class: "check__label" }, label_text),
      note && h("span", { class: "check__note" }, note),
    ),
  );
  wrap.input = box;
  return wrap;
}

/** 結果カード。main が最も大きい数字、subs はその内訳の主要項目 */
export function result_card(main_label, main_value, subs = []) {
  return h("section", { class: "result" },
    h("p", { class: "result__label" }, main_label),
    h("p", { class: "result__value" }, main_value),
    subs.length > 0 &&
      h("dl", { class: "result__subs" },
        subs.map((s) => [
          h("dt", {}, s.label),
          h("dd", {}, s.value),
        ]).flat(),
      ),
  );
}

/** 計算過程。1行＝1ステップ */
export function breakdown(steps) {
  return h("section", { class: "block" },
    h("h2", { class: "block__title" }, "計算過程"),
    h("ol", { class: "steps" },
      steps.map((s) =>
        h("li", { class: "step" },
          h("span", { class: "step__label" }, s.label),
          h("span", { class: "step__value" }, s.value),
          s.note && h("span", { class: "step__note" }, s.note),
        ),
      ),
    ),
  );
}

/**
 * 年ごとの表（減価償却のスケジュール）。
 * 罫線で囲わず、行の区切りだけを薄く入れる（内部ツール4原則）。
 */
export function schedule_table(title, rows) {
  return h("section", { class: "block" },
    h("h2", { class: "block__title" }, title),
    h("table", { class: "schedule" },
      h("thead", {},
        h("tr", {},
          h("th", { class: "schedule__th" }, "年目"),
          h("th", { class: "schedule__th schedule__th--num" }, "償却費"),
          h("th", { class: "schedule__th schedule__th--num" }, "期末簿価"),
        ),
      ),
      h("tbody", {},
        rows.map((r) =>
          h("tr", {},
            h("td", { class: "schedule__year" },
              h("span", {}, `${r.year}`),
              r.note && h("span", { class: "schedule__note" }, r.note),
            ),
            h("td", { class: "schedule__num" }, r.amount),
            h("td", { class: "schedule__num schedule__num--muted" }, r.balance),
          ),
        ),
      ),
    ),
  );
}

/** 入力欄のすぐ下に出す1行の注意（画面下まで読まれない前提で置く） */
export function warn_line(text) {
  return h("p", { class: "warn" }, text);
}

/** 根拠・注意など、文章のかたまり */
export function note_block(title, items) {
  return h("section", { class: "block" },
    h("h2", { class: "block__title" }, title),
    h("ul", { class: "notes" }, items.map((t) => h("li", {}, t))),
  );
}

/** 計算できないときの表示 */
export function message_box(text) {
  return h("p", { class: "message" }, text);
}
