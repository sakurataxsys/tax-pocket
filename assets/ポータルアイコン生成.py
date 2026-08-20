# -*- coding: utf-8 -*-
"""kintone ポータルの丸アイコン（100x126）と、配布用のQRコードを作る。

アイコンの絵柄は **アプリ本体のアイコン（`icons/icon-512.png`）を丸く切って使う**。
職員がスマートフォンのホーム画面で見ているのと同じ絵がポータルにも並ぶので、
「これがあのアプリ」と一目で繋がる（2026-08-20 ユーザー判断）。
　・アプリ本体のアイコンの背景は一様なネイビー #0F254A なので、円に切っても継ぎ目が出ない
　・ラベルは画像に焼き込む（ポータルの既存の丸アイコンがそうなっているため）
　・お知らせ掲示板へはクリップボード経由で貼るので、白背景版も出力する

★アプリ本体のアイコンを作り直すのは `tools/icon-source.html`。ここではそれを読むだけで、
　手で画像を編集しない。本体のアイコンを変えたら、このスクリプトを流し直してポータルの
　アイコンも差し替える。

実行：py assets/ポータルアイコン生成.py
"""
from pathlib import Path

import qrcode
from PIL import Image, ImageDraw, ImageFont

S = 4  # 4倍で描いて縮小する（文字を滑らかにするため）
W, H = 100 * S, 126 * S
TEXT = (51, 51, 51, 255)
LINES = ["税額ポケット"]
URL = "https://sakurataxsys.github.io/tax-pocket/"

here = Path(__file__).parent
repo = here.parent

# アプリ本体のアイコンを円に切る
cd = 96 * S
art = Image.open(repo / "icons" / "icon-512.png").convert("RGBA").resize((cd, cd), Image.LANCZOS)
mask = Image.new("L", (cd, cd), 0)
ImageDraw.Draw(mask).ellipse([0, 0, cd - 1, cd - 1], fill=255)

img = Image.new("RGBA", (W, H), (255, 255, 255, 0))
img.paste(art, ((W - cd) // 2, 0), mask)

# ラベル
d = ImageDraw.Draw(img)
font = ImageFont.truetype("C:/Windows/Fonts/YuGothB.ttc", 11 * S)
y = 99 * S
for line in LINES:
    bb = d.textbbox((0, 0), line, font=font)
    d.text(((W - (bb[2] - bb[0])) // 2 - bb[0], y), line, font=font, fill=TEXT)
    y += 13 * S

out = img.resize((100, 126), Image.LANCZOS)
out.save(here / "ポータルアイコン_税額ポケット.png")

# クリップボード貼り付け用（透明を白に落とす。DIB は透明を保持しないため）
bg = Image.new("RGBA", out.size, (255, 255, 255, 255))
bg.alpha_composite(out)
bg.convert("RGB").save(here / "ポータルアイコン_税額ポケット_白背景.png")

# 配布用のQRコード（レコードに添付し、職員がスマートフォンで読み取る）
qr = qrcode.QRCode(
    version=None,
    error_correction=qrcode.constants.ERROR_CORRECT_M,
    box_size=16,
    border=4,
)
qr.add_data(URL)
qr.make(fit=True)
qr.make_image(fill_color="black", back_color="white").save(here / "QRコード_税額ポケット.png")

print("生成しました：", here)
