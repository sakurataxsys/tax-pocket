# -*- coding: utf-8 -*-
"""kintone ポータルの丸アイコン（100x126）と、配布用のQRコードを作る。

丸アイコンの意匠は、ポータルに並んでいる既存の丸アイコン
（生成AI-OCR Scan-to-Journal・上手な税務調査の受け方 等）に合わせている。
　・円は塗りつぶし、影とグラデーションは使わない
　・ラベルは画像に焼き込む（既存のアイコンがそうなっているため）
　・お知らせ掲示板へはクリップボード経由で貼るので、白背景版も出力する

★このアイコンは kintone ポータル用で、アプリ本体のアイコン（icons/*.png・桜のマーク）とは別物。
　アプリ本体のアイコンは tools/icon-source.html で作る。片方を見てもう片方を直さないこと。

実行：py assets/ポータルアイコン生成.py
"""
from pathlib import Path

import qrcode
from PIL import Image, ImageDraw, ImageFont

S = 4  # 4倍で描いて縮小する（文字を滑らかにするため）
W, H = 100 * S, 126 * S
NAVY = (21, 40, 71, 255)  # 事務所ブランドのネイビー #152847
WHITE = (255, 255, 255, 255)
TEXT = (51, 51, 51, 255)
LINES = ["税額ポケット"]
URL = "https://sakurataxsys.github.io/tax-pocket/"

img = Image.new("RGBA", (W, H), (255, 255, 255, 0))
d = ImageDraw.Draw(img)

# 円
cd = 96 * S
cx, cy = W // 2, cd // 2
d.ellipse([cx - cd // 2, cy - cd // 2, cx + cd // 2, cy + cd // 2], fill=NAVY)

# スマートフォン（白い本体＋ネイビーの画面）
pw, ph = 42 * S, 64 * S
px, py = cx - pw // 2, cy - ph // 2
d.rounded_rectangle([px, py, px + pw, py + ph], radius=5 * S, fill=WHITE)
d.rounded_rectangle(
    [px + 4 * S, py + 7 * S, px + pw - 4 * S, py + ph - 7 * S], radius=2 * S, fill=NAVY
)

# 画面の中の「¥」（フォントに依存しないよう線で描く）
yw = 3 * S  # 線の太さ
d.line([cx - 10 * S, cy - 13 * S, cx, cy - 2 * S], fill=WHITE, width=yw)
d.line([cx + 10 * S, cy - 13 * S, cx, cy - 2 * S], fill=WHITE, width=yw)
d.line([cx, cy - 3 * S, cx, cy + 13 * S], fill=WHITE, width=yw)
for by in (cy + 2 * S, cy + 8 * S):
    d.line([cx - 8 * S, by, cx + 8 * S, by], fill=WHITE, width=int(2.5 * S))

# ラベル
font = ImageFont.truetype("C:/Windows/Fonts/YuGothB.ttc", 11 * S)
y = 99 * S
for line in LINES:
    bb = d.textbbox((0, 0), line, font=font)
    d.text(((W - (bb[2] - bb[0])) // 2 - bb[0], y), line, font=font, fill=TEXT)
    y += 13 * S

here = Path(__file__).parent
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
