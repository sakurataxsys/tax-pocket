// 適用年分に対応する版を取り出す。
//
// data/*.json は改正のたびに上書きせず「版」を足していく（data/CLAUDE.md の守ること2）。
// 過年度の試算（修正申告・遺産分割のやり直し）を関与先で出すため、旧年度のデータを消さない。
//
// 「適用終了年」が null の版は現在も有効という意味。該当する版がなければ null を返す。

export function pick_version(versions, nen) {
  return (
    versions.find(
      (v) =>
        nen >= v["適用開始年"] &&
        (v["適用終了年"] === null || nen <= v["適用終了年"]),
    ) ?? null
  );
}
