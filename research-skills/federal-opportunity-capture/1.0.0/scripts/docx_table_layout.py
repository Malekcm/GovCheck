"""Reliable Word table helper. Reusable in future research reports.
Run as an import from a python-docx report generator; see SKILL.md.
"""
from docx.shared import Inches, Pt, RGBColor
from docx.enum.table import WD_TABLE_ALIGNMENT, WD_CELL_VERTICAL_ALIGNMENT
from docx.oxml import OxmlElement
from docx.oxml.ns import qn

def _shade(cell, fill):
    p=cell._tc.get_or_add_tcPr()
    x=p.find(qn('w:shd'))
    if x is None: x=OxmlElement('w:shd');p.append(x)
    x.set(qn('w:fill'),fill)

def _margin(cell):
    p=cell._tc.get_or_add_tcPr();m=p.find(qn('w:tcMar'))
    if m is None:m=OxmlElement('w:tcMar');p.append(m)
    for side in ('top','start','bottom','end'):
        k=m.find(qn('w:'+side))
        if k is None:k=OxmlElement('w:'+side);m.append(k)
        k.set(qn('w:type'),'dxa');k.set(qn('w:w'),'65' if side in ('top','bottom') else '95')

def add_fixed_table(document, headers, rows, widths, text_size=7.8, header_size=8.0):
    """Add stable table; widths are inches. Caller ensures sum <= available text width."""
    assert len(headers)==len(widths), 'header/width mismatch'
    assert all(len(r)==len(headers) for r in rows), 'row length mismatch'
    sec=document.sections[-1]
    available=(sec.page_width-sec.left_margin-sec.right_margin)/914400.0
    if sum(widths)>available+0.005:
        raise ValueError(f'table widths sum {sum(widths):.2f}, available {available:.2f}')
    table=document.add_table(rows=1,cols=len(headers))
    table.style='Table Grid';table.autofit=False;table.alignment=WD_TABLE_ALIGNMENT.LEFT
    tp=table._tbl.tblPr;tw=tp.find(qn('w:tblW'))
    if tw is None:tw=OxmlElement('w:tblW');tp.append(tw)
    tw.set(qn('w:type'),'dxa');tw.set(qn('w:w'),str(round(sum(widths)*1440)))
    ti=tp.find(qn('w:tblInd'))
    if ti is None:ti=OxmlElement('w:tblInd');tp.append(ti)
    ti.set(qn('w:type'),'dxa');ti.set(qn('w:w'),'0')
    for i,w in enumerate(widths):table.columns[i].width=Inches(w)
    for index,values in enumerate([headers]+list(rows)):
        row=table.rows[0] if index==0 else table.add_row()
        for i,val in enumerate(values):
            c=row.cells[i];c.width=Inches(widths[i]);c.text=str(val)
            c.vertical_alignment=WD_CELL_VERTICAL_ALIGNMENT.CENTER;_margin(c)
            if index==0:_shade(c,'1B3659')
            elif index%2==0:_shade(c,'F1F5F8')
            for p in c.paragraphs:
                p.paragraph_format.space_after=Pt(0);p.paragraph_format.space_before=Pt(0)
                p.paragraph_format.line_spacing=1.05
                for run in p.runs:
                    run.font.name='Carlito';run.font.size=Pt(header_size if index==0 else text_size)
                    run.font.bold=index==0
                    run.font.color.rgb=RGBColor(255,255,255) if index==0 else RGBColor(21,37,62)
        props=row._tr.get_or_add_trPr()
        if index==0:
            flag=OxmlElement('w:tblHeader');flag.set(qn('w:val'),'true');props.append(flag)
        else:
            flag=OxmlElement('w:cantSplit');props.append(flag)
    return table
