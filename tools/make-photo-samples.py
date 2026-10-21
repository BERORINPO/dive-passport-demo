# 見本の写真 (架空) を assets/samples/ に作る。画面の「見本の写真」ボタン用。
# 申込書は、AI の読み取り試験 (2026-10-21) と同じ書き方・同じ写り方で、健康の欄を塗る前の写真を作る
# (塗るのは画面の仕事なので、塗る前が要る)。C カードは試験で送った写真をそのまま使う (健康の欄が無い)。
# 試験の生成スクリプトから関数の定義だけを借り、試験のフォルダには何も書かない。
# 実行: python tools/make-photo-samples.py <ai-ocr-test フォルダ>
import os
import random
import shutil
import sys

from PIL import Image

if len(sys.argv) < 2:
    sys.exit('usage: python tools/make-photo-samples.py <ai-ocr-test folder>')
TEST = sys.argv[1]
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets', 'samples')
MAX_SIDE = 1600      # 画面で描き直す大きさと同じ
QUALITY = 82

src = open(os.path.join(TEST, 'tools', 'gen_samples.py'), encoding='utf-8').read()
defs = src[:src.index('docs = []')]       # 生成して書き出す所の手前まで (関数と見本の定義だけ)
ns = {'__file__': os.path.join(TEST, 'tools', 'gen_samples.py'), '__name__': 'gen_samples_defs'}
exec(compile(defs, 'gen_samples.py', 'exec'), ns)


def save(im, name):
    im = im.convert('RGB')
    scale = MAX_SIDE / max(im.size)
    if scale < 1:
        im = im.resize((round(im.width * scale), round(im.height * scale)), Image.LANCZOS)
    im.save(os.path.join(OUT, name), 'JPEG', quality=QUALITY, optimize=True)
    print(name, im.size, os.path.getsize(os.path.join(OUT, name)))


random.seed(20261021)
for f in ns['FORMS']:
    im = ns['form'](f)
    save(ns['photo'](im, **f['fx']) if f['fx'] else im, f['id'] + '.jpg')
for c in ns['CARDS']:
    shutil.copyfile(os.path.join(TEST, 'samples', 'send', c['id'] + '.jpg'), os.path.join(OUT, c['id'] + '.jpg'))
    print(c['id'] + '.jpg', 'copied')
