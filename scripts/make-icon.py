from PIL import Image, ImageDraw

# 从用户提供的品牌图生成应用图标：去掉外层白底 → 透明，再导出 PNG / ICO / 侧栏小图。
SRC = "assets/icon-source.png"
img = Image.open(SRC).convert("RGBA")

# 从四角泛洪填充白底（阈值 8，避开奶油色圆角底 ~243,238,233）
for seed in [(0, 0), (img.width - 1, 0), (0, img.height - 1), (img.width - 1, img.height - 1)]:
    ImageDraw.floodfill(img, seed, (0, 0, 0, 0), thresh=8)

# 裁到实际内容，留 2% 边距
bbox = img.getbbox()
if bbox:
    pad = int(max(bbox[2] - bbox[0], bbox[3] - bbox[1]) * 0.02)
    bbox = (max(0, bbox[0] - pad), max(0, bbox[1] - pad), min(img.width, bbox[2] + pad), min(img.height, bbox[3] + pad))
    img = img.crop(bbox)

big = img.resize((512, 512), Image.LANCZOS)
big.save("assets/icon.png")
big.resize((256, 256), Image.LANCZOS).save("assets/icon-256.png")
big.resize((64, 64), Image.LANCZOS).save("assets/brand.png")
big.save("assets/icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print("ok", big.size)
