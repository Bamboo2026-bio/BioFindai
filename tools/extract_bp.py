#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
批量提取 BioTech案例/ 目录下 PDF / PPTX 商业计划书的文本，
输出到 BioTech案例/_extracted/<案例名>.txt，供 bp-engine.js 分析使用。

用法：
    python3 tools/extract_bp.py            # 提取全部
    python3 tools/extract_bp.py --force    # 覆盖已存在的 txt
"""
import os
import re
import sys
import glob

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DIR = os.path.join(BASE, 'BioTech案例')
OUT_DIR = os.path.join(SRC_DIR, '_extracted')


def clean(text: str) -> str:
    """清理提取文本：合并多余空白、去除孤立控制字符。"""
    text = text.replace('\u00a0', ' ').replace('\u3000', ' ')
    text = re.sub(r'[ \t]+', ' ', text)
    text = re.sub(r'\n{3,}', '\n\n', text)
    # 去掉纯符号/页码行
    lines = []
    for ln in text.split('\n'):
        s = ln.strip()
        if not s:
            lines.append('')
            continue
        if re.fullmatch(r'[\d\s\-—–/·.、%]+', s):
            continue
        lines.append(s)
    return '\n'.join(lines).strip()


def extract_pdf(path: str) -> str:
    import pymupdf
    parts = []
    with pymupdf.open(path) as doc:
        for page in doc:
            parts.append(page.get_text('text'))
    return '\n'.join(parts)


def extract_pptx(path: str) -> str:
    from pptx import Presentation
    parts = []
    prs = Presentation(path)
    for idx, slide in enumerate(prs.slides, 1):
        parts.append(f'\n--- 第{idx}页 ---')
        for shape in slide.shapes:
            if shape.has_text_frame:
                t = shape.text_frame.text.strip()
                if t:
                    parts.append(t)
            if getattr(shape, 'has_table', False) and shape.has_table:
                for row in shape.table.rows:
                    cells = [c.text.strip() for c in row.cells]
                    if any(cells):
                        parts.append(' | '.join(cells))
    return '\n'.join(parts)


def main():
    force = '--force' in sys.argv
    os.makedirs(OUT_DIR, exist_ok=True)
    files = sorted(glob.glob(os.path.join(SRC_DIR, '*.pdf')) +
                   glob.glob(os.path.join(SRC_DIR, '*.pptx')))
    if not files:
        print('未找到 PDF/PPTX 文件')
        return

    for path in files:
        name = os.path.splitext(os.path.basename(path))[0]
        # 文件名规范化：去掉版本号/括号等噪声
        name = re.sub(r'[（(]\d+[)）]$', '', name)
        name = re.sub(r'\s*[-_]\s*\d{4}[.\-]?\d{0,2}[.\-]?\d{0,2}.*$', '', name)
        name = name.strip()
        out = os.path.join(OUT_DIR, name + '.txt')
        if os.path.exists(out) and not force:
            print(f'跳过（已存在）: {name}')
            continue
        try:
            if path.lower().endswith('.pdf'):
                raw = extract_pdf(path)
            else:
                raw = extract_pptx(path)
            text = clean(raw)
            with open(out, 'w', encoding='utf-8') as f:
                f.write(text)
            print(f'✓ {name}: {len(text)} 字')
        except Exception as e:
            print(f'✗ {name}: {type(e).__name__}: {e}')


if __name__ == '__main__':
    main()
