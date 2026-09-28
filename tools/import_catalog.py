"""Одноразовый импорт: Каталог схем.csv + PNG -> content/ (JSON + WebP).

Запуск: python3 tools/import_catalog.py <папка со схемами>
Повторный запуск безопасен: уже сконвертированные картинки пропускаются.
"""
import csv
import json
import os
import sys

from PIL import Image

SRC = sys.argv[1]
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCHEMES = os.path.join(ROOT, "content", "schemes")
SECTIONS = os.path.join(ROOT, "content", "sections")
IMAGES = os.path.join(ROOT, "content", "images")
for d in (SCHEMES, SECTIONS, IMAGES):
    os.makedirs(d, exist_ok=True)

TR = dict(zip("абвгдеёжзийклмнопрстуфхцчшщъыьэюя",
              ["a", "b", "v", "g", "d", "e", "e", "zh", "z", "i", "y", "k", "l", "m", "n", "o", "p",
               "r", "s", "t", "u", "f", "kh", "ts", "ch", "sh", "shch", "", "y", "", "e", "yu", "ya"]))


def slugify(s):
    out = "".join(TR.get(c, c) for c in s.lower())
    out = "".join(c if c.isalnum() and c.isascii() else "-" for c in out)
    while "--" in out:
        out = out.replace("--", "-")
    return out.strip("-")


# Группы пациентов: «Все / не уточнено» = пустой список
PATIENTS = {"Взрослые", "Дети и подростки", "Новорождённые и младенцы", "Беременные"}

rows = list(csv.DictReader(open(os.path.join(SRC, "Каталог схем.csv"), encoding="utf-8-sig")))

# Порядок разделов — по числу схем (самые крупные сверху)
counts = {}
for r in rows:
    counts[r["Раздел"]] = counts.get(r["Раздел"], 0) + 1
for i, (name, _) in enumerate(sorted(counts.items(), key=lambda x: (-x[1], x[0]))):
    with open(os.path.join(SECTIONS, slugify(name) + ".json"), "w", encoding="utf-8") as f:
        json.dump({"name": name, "order": i + 1}, f, ensure_ascii=False, indent=2)

missing = []
for r in rows:
    sid = r["ID"].strip().lower()
    patients = [p.strip() for p in r["Пациенты"].split(";") if p.strip() in PATIENTS]
    extra = [s.strip() for s in r["Доп. раздел"].split(";") if s.strip()]
    entry = {
        "title": r["Название"].strip(),
        "section": r["Раздел"].strip(),
        "extra_sections": extra,
        "type": r["Тип"].strip(),
        "patients": patients,
        "keywords": r["Ключевые слова"].strip(),
        "title_en": os.path.splitext(r["Исходное название"].strip())[0],
        "image": f"/images/{sid}.webp",
    }
    with open(os.path.join(SCHEMES, sid + ".json"), "w", encoding="utf-8") as f:
        json.dump(entry, f, ensure_ascii=False, indent=2)

    dst = os.path.join(IMAGES, sid + ".webp")
    src = os.path.join(SRC, r["Файл"])
    if os.path.exists(dst):
        continue
    if not os.path.exists(src):
        missing.append(r["Файл"])
        continue
    im = Image.open(src)
    if im.mode in ("RGBA", "LA", "P"):
        im = im.convert("RGBA")
        bg = Image.new("RGB", im.size, "white")
        bg.paste(im, mask=im.split()[-1])
        im = bg
    im.save(dst, "WEBP", quality=82, method=6)

print(f"схем: {len(rows)}, разделов: {len(counts)}, нет картинок: {len(missing)}")
