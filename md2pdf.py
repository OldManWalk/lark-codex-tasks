#!/usr/bin/env python3
# lark-codex-tasks — 任务报告 Markdown → PDF（reportlab，内嵌中文 TTF；缺字体时退化 CID 字体）。
# 用法: python3 md2pdf.py <input.md> <output.pdf> [font.ttf]
# 尽力渲染：标题/表格/列表/代码块/加粗；任何解析异常退化为纯文本排版，保证文件一定产出。
import html
import re
import sys

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.platypus import Paragraph, Preformatted, SimpleDocTemplate, Spacer, Table, TableStyle


def register_font(path):
    if path:
        try:
            from reportlab.pdfbase.ttfonts import TTFont
            pdfmetrics.registerFont(TTFont("NotoSC", path))
            pdfmetrics.registerFontFamily("NotoSC", normal="NotoSC", bold="NotoSC", italic="NotoSC", boldItalic="NotoSC")
            return "NotoSC"
        except Exception:
            pass
    try:
        from reportlab.pdfbase.cidfonts import UnicodeCIDFont
        pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
        return "STSong-Light"
    except Exception:
        return "Helvetica"


def styles(font):
    from reportlab.lib.styles import ParagraphStyle
    return {
        "body": ParagraphStyle("body", fontName=font, fontSize=10.5, leading=16, spaceAfter=4),
        "h1": ParagraphStyle("h1", fontName=font, fontSize=16, leading=22, spaceBefore=10, spaceAfter=6, textColor=colors.HexColor("#1a1a2e")),
        "h2": ParagraphStyle("h2", fontName=font, fontSize=13.5, leading=19, spaceBefore=8, spaceAfter=5, textColor=colors.HexColor("#1a1a2e")),
        "h3": ParagraphStyle("h3", fontName=font, fontSize=11.5, leading=17, spaceBefore=6, spaceAfter=4, textColor=colors.HexColor("#33334d")),
        "code": ParagraphStyle("code", fontName=font, fontSize=9, leading=13, backColor=colors.HexColor("#f4f4f6")),
        "cell": ParagraphStyle("cell", fontName=font, fontSize=9, leading=13),
    }


def inline(text):
    text = strip_emoji(text)
    out = html.escape(text)
    out = re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", out)
    out = re.sub(r"`([^`]+)`", r"<b>\1</b>", out)  # 内联代码不切换字体：Helvetica 无中文字形会出豆腐块
    return out


def is_table_line(line):
    s = line.strip()
    return s.startswith("|") and s.endswith("|") and s.count("|") >= 2


# 变体选择符/零宽连接符/星面 emoji 在 Noto Sans SC 里会变成豆腐块；BMP 符号（⚠✅等）字体可渲染，保留。
_EMOJI_RE = re.compile("[\uFE0E\uFE0F\u200D\u20E3\U0001F000-\U0001FAFF]")


def strip_emoji(text):
    return _EMOJI_RE.sub("", text)


def render(text, st):
    story, lines, i = [], text.split("\n"), 0
    while i < len(lines):
        line = lines[i]
        if re.match(r"^\s*(```|~~~)", line):  # 代码块
            buf, i = [], i + 1
            while i < len(lines) and not re.match(r"^\s*(```|~~~)", lines[i]):
                buf.append(lines[i])
                i += 1
            i += 1
            story.append(Preformatted(strip_emoji("\n".join(buf)) or " ", st["code"]))
            continue
        if is_table_line(line):  # 表格块
            rows = []
            while i < len(lines) and is_table_line(lines[i]):
                cells = [c.strip() for c in lines[i].strip().strip("|").split("|")]
                if not all(re.fullmatch(r":?-{2,}:?", c or "") for c in cells):  # 跳过分隔行
                    rows.append([Paragraph(inline(c) or " ", st["cell"]) for c in cells])
                i += 1
            if rows:
                n = max(len(r) for r in rows)
                rows = [r + [Paragraph(" ", st["cell"])] * (n - len(r)) for r in rows]
                tbl = Table(rows, colWidths=[(A4[0] - 36 * mm) / n] * n, repeatRows=1)
                tbl.setStyle(TableStyle([
                    ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#c8c8d0")),
                    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#eef0f4")),
                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                    ("LEFTPADDING", (0, 0), (-1, -1), 4), ("RIGHTPADDING", (0, 0), (-1, -1), 4),
                    ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
                ]))
                story.append(tbl)
                story.append(Spacer(1, 4))
            continue
        m = re.match(r"^\s*(#{1,3})\s+(.+?)\s*#*\s*$", line)
        if m:
            story.append(Paragraph(inline(m.group(2)), st["h" + str(len(m.group(1)))]))
        elif re.match(r"^\s*([-*+]|\d+[.、])\s+", line):
            story.append(Paragraph("• " + inline(re.sub(r"^\s*([-*+]|\d+[.、])\s+", "", line)), st["body"]))
        elif re.match(r"^\s*-{3,}\s*$", line) or not line.strip():
            story.append(Spacer(1, 4))
        else:
            story.append(Paragraph(inline(line), st["body"]))
        i += 1
    return story


def main():
    md_path, pdf_path = sys.argv[1], sys.argv[2]
    font_path = sys.argv[3] if len(sys.argv) > 3 else ""
    st = styles(register_font(font_path))
    text = open(md_path, encoding="utf-8").read()
    try:
        story = render(text, st)
    except Exception:  # 排版失败不阻断交付：纯文本兜底
        story = [Preformatted(strip_emoji(text), st["code"])]
    if not story:
        story = [Paragraph("(空报告)", st["body"])]
    doc = SimpleDocTemplate(pdf_path, pagesize=A4, leftMargin=18 * mm, rightMargin=18 * mm, topMargin=16 * mm, bottomMargin=16 * mm,
                            title="任务报告", author="lark-codex-tasks")
    doc.build(story)


if __name__ == "__main__":
    main()
