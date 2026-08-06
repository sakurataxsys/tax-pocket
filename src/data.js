// data/*.json の読み込み。
//
// ★毎回取りに行く（メモリに抱え込まない）。
// ホーム画面から起動したPWAには再読込ボタンがないため、起動時に1回だけ読むと
// 「朝開いたまま夕方の関与先で使う」端末に、その日の差し替えが届かない。
// 通信の制御（オンラインなら最新・つながらなければ端末のキャッシュ）は service worker 側で行う。

export async function load_data(name) {
  // service worker が無い環境（初回訪問・未対応ブラウザ）でも
  // GitHub Pages の HTTP キャッシュを掴まないよう reload を指定する。
  const res = await fetch(`./data/${name}.json`, { cache: "reload" });
  if (!res.ok) throw new Error(`${name}.json を読み込めませんでした`);
  return res.json();
}

/** 退職金の計算に必要なデータをまとめて読む */
export async function load_taishokukin_tables() {
  const [taishokukin, income_tax] = await Promise.all([
    load_data("taishokukin"),
    load_data("income_tax_rates"),
  ]);
  return { taishokukin, income_tax };
}

/** 減価償却の計算に必要なデータをまとめて読む */
export async function load_genka_shokyaku_tables() {
  const [shokyakuritsu, genka_shokyaku] = await Promise.all([
    load_data("shokyakuritsu"),
    load_data("genka_shokyaku"),
  ]);
  return { shokyakuritsu, genka_shokyaku };
}

/** 延滞税・利子税の計算に必要なデータをまとめて読む */
export async function load_entaizei_tables() {
  const entaizei = await load_data("entaizei");
  return { entaizei };
}

/** 法人税の早見表の率 */
export async function load_hojinzei_hayami() {
  return load_data("hojinzei_hayami");
}

/** リンク集 */
export async function load_link_shu() {
  return load_data("link_shu");
}

/** 登録免許税の計算に必要なデータをまとめて読む */
export async function load_toroku_menkyozei_tables() {
  const [toroku_menkyozei, toroku_menkyozei_hyo] = await Promise.all([
    load_data("toroku_menkyozei"),
    load_data("toroku_menkyozei_hyo"),
  ]);
  return { toroku_menkyozei, toroku_menkyozei_hyo };
}

/** 印紙税の計算に必要なデータをまとめて読む */
export async function load_inshizei_tables() {
  const [inshizei, inshizei_hyo] = await Promise.all([
    load_data("inshizei"),
    load_data("inshizei_hyo"),
  ]);
  return { inshizei, inshizei_hyo };
}

/** 元号早見表 */
export async function load_gengo() {
  return load_data("gengo");
}

/** ふるさと納税の計算に必要なデータをまとめて読む（所得税エンジン＋割合表） */
export async function load_furusato_tables() {
  const [tables, furusato] = await Promise.all([
    load_shotokuzei_tables(),
    load_data("furusato"),
  ]);
  return { ...tables, furusato };
}

/** 所得税エンジンに必要なデータをまとめて読む（画面はふるさと納税から呼ぶ） */
export async function load_shotokuzei_tables() {
  const [shotokuzei, juminzei, bunri_kazei, income_tax] = await Promise.all([
    load_data("shotokuzei"),
    load_data("juminzei"),
    load_data("bunri_kazei"),
    load_data("income_tax_rates"),
  ]);
  return { shotokuzei, juminzei, bunri_kazei, income_tax };
}
