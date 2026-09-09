import os
import qrcode
from qrcode.image.svg import SvgImage

BASE = "https://yuen-cloud-d9g0mo1bv654d2ff6-1394617281.tcloudbaseapp.com/"
ROOMS = {'1': '谷山玥', '2': '满仓', '3': '枕山', '5': '云起'}
OUT = os.path.join(os.path.dirname(__file__), 'qr')
os.makedirs(OUT, exist_ok=True)

# 1) 生成 4 个包厢二维码 SVG
urls = {}
for no, name in ROOMS.items():
    url = BASE + "?tableNo=" + no
    urls[no] = url
    qr = qrcode.QRCode(box_size=10, border=4, error_correction=qrcode.constants.ERROR_CORRECT_M)
    qr.add_data(url)
    qr.make(fit=True)
    img = qr.make_image(image_factory=SvgImage, fill_color="#1a1a1a", back_color="#ffffff")
    path = os.path.join(OUT, f"room_{no}.svg")
    img.save(path)
    print("saved", path, "->", url)

# 2) 生成可打印汇总页 rooms.html
cards = ""
for no, name in ROOMS.items():
    cards += f"""
      <div class="card">
        <img src="qr/room_{no}.svg" alt="{name}" />
        <div class="rn">{name}</div>
        <div class="rt">{no} 号包厢</div>
        <div class="ru">{urls[no]}</div>
        <div class="tip">顾客扫码即可点餐</div>
      </div>"""

html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>包厢点餐二维码</title>
<style>
  * {{ box-sizing: border-box; }}
  body {{ font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; background:#f5f6f8; color:#1a1a1a; margin:0; padding:24px; }}
  h1 {{ text-align:center; font-weight:600; margin-bottom:4px; }}
  .sub {{ text-align:center; color:#888; font-size:13px; margin-bottom:24px; }}
  .grid {{ display:grid; grid-template-columns:repeat(2, 1fr); gap:20px; max-width:760px; margin:0 auto; }}
  .card {{ background:#fff; border-radius:14px; padding:18px; text-align:center; box-shadow:0 1px 4px rgba(0,0,0,.06); }}
  .card img {{ width:200px; height:200px; }}
  .rn {{ font-size:20px; font-weight:600; margin-top:10px; }}
  .rt {{ color:#888; font-size:13px; margin-top:2px; }}
  .ru {{ color:#185FA5; font-size:11px; margin-top:8px; word-break:break-all; }}
  .tip {{ color:#d85a30; font-size:12px; margin-top:6px; }}
  @media print {{ body {{ background:#fff; }} .card {{ box-shadow:none; border:1px solid #eee; }} }}
</style>
</head>
<body>
  <h1>包厢点餐二维码</h1>
  <div class="sub">示例餐厅 · 扫码即点</div>
  <div class="grid">{cards}
  </div>
</body>
</html>"""

with open(os.path.join(os.path.dirname(__file__), 'rooms.html'), 'w', encoding='utf-8') as f:
    f.write(html)
print("saved rooms.html")
