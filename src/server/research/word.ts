import { Document, Packer, Paragraph, TextRun, HeadingLevel, ExternalHyperlink, Table, TableRow, TableCell, WidthType, TableLayoutType, Footer, PageNumber } from 'docx';
import { loadWorkflow, type Report, type Source } from './workflow';

/** Fixed Letter-page layout; long answer registers use vertically stacked rows. */
export async function reportDocx(run: any): Promise<Buffer> {
  const report = run.report as Report & { sources: Source[] };
  const questions=new Map(loadWorkflow().questions.map(q=>[q.id,q.question]));
  const heading = (text: string,pageBreakBefore=false) => new Paragraph({ text,heading:HeadingLevel.HEADING_1,keepNext:true,pageBreakBefore });
  const para = (text: string,keepNext=false) => new Paragraph({ text,keepNext,keepLines:true,spacing:{ after:100 } });
  const table = (headers:string[], rows:string[][]) => {
    const widths = headers.length === 3 ? [2400,2400,5280] : [2880,7200];
    return new Table({ width:{size:10080,type:WidthType.DXA},columnWidths:widths,layout:TableLayoutType.FIXED,
      rows:[headers,...rows].map((cells,i) => new TableRow({tableHeader:i===0,cantSplit:true,children:cells.map((text,j) => new TableCell({width:{size:widths[j],type:WidthType.DXA},shading:i===0 ? {fill:'24354B'} : {fill:i%2 ? 'F3F5F7' : 'FFFFFF'},children:[new Paragraph({children:[new TextRun({text,bold:i===0,color:i===0 ? 'FFFFFF' : '000000',size:18})]})]}))})) });
  };
  const doc = new Document({ creator:'GovCheck',title:'Federal Opportunity Capture Research',
    styles:{default:{document:{run:{font:'Arial',size:20,color:'000000'}}},paragraphStyles:[
      {id:'Normal',name:'Normal',run:{font:'Arial',size:20,color:'000000'}},
      {id:'Title',name:'Title',basedOn:'Normal',run:{color:'000000',size:40,bold:true}},
      {id:'Heading1',name:'Heading 1',basedOn:'Normal',run:{color:'000000',size:28,bold:true}},
      {id:'Heading2',name:'Heading 2',basedOn:'Normal',run:{color:'000000',size:22,bold:true}},
    ]},
    sections:[{properties:{page:{size:{width:12240,height:15840},margin:{top:1080,bottom:1080,left:1080,right:1080}}},footers:{default:new Footer({children:[new Paragraph({children:[new TextRun({children:['GovCheck capture research · Page ',PageNumber.CURRENT],size:16})]})]})},children:[
      new Paragraph({text:'Federal Opportunity Capture Research',heading:HeadingLevel.TITLE}),
      para(run.snapshot.opportunity.title),para(`${run.snapshot.opportunity.department_name ?? 'Agency unverified'} · ${run.snapshot.opportunity.solicitation_number ?? 'Solicitation unverified'}`),
      para(`As of ${run.completed_at} · Initiated by ${run.initiated_by_name} · Workflow ${run.skill_version}`),
      para('Conditional research assessment. Current solicitation access and mandatory eligibility must be verified. Human approval is required for every bid decision.'),
      heading('Executive gate recommendation',true),para(report.executiveSummary),para(report.conditionalRecommendation),
      ...report.sections.flatMap((s,i) => [heading(s.title,i===0),para(s.text),para(`Evidence: ${s.sourceIds.join(', ') || 'OPEN'}`)]),
      heading('Company requirements and evidence'),table(['Requirement','Fit and status','Evidence and owner'],report.capabilityMatrix.map(m => [m.requirement,`${m.fit} / ${m.status}`,`${m.evidence}\nOwner: ${m.owner}\nSources: ${m.sourceIds.join(', ')}`])),
      heading('Risks and hard gates'),...report.risks.map(r=>para(r)),
      heading('Research and capture plan'),...report.nextActions.map(a => para(`${a.owner} · ${a.dueDate ?? 'Date to be assigned'} · ${a.action}`)),
      heading('Procurement discovery register'),...report.queryLog.map(q => para(`${q.checkedOn} · ${q.surface} · ${q.query}\n${q.result}`)),
      heading('BD answer register'),...report.answers.flatMap(a => [new Paragraph({text:`${a.id} ${a.status}`,heading:HeadingLevel.HEADING_2,keepNext:true}),para(questions.get(a.id)??a.id,true),para(a.answer,true),para(`Sources: ${a.sourceIds.join(', ') || 'OPEN'} · Checked: ${a.checkedOn}`,true),para(`Owner: ${a.owner} · ${a.urgency} · Evidence request: ${a.evidenceRequest}`)]),
      heading('Source register'),...report.sources.flatMap(s => [new Paragraph({children:[new ExternalHyperlink({link:s.url,children:[new TextRun({text:s.title || 'Official source',style:'Hyperlink'})]})]}),para(`${s.id} · ${s.retrievedAt} · ${s.caveat}`)]),
      heading('Open evidence requests'),...report.answers.filter(a => ['OPEN','CONFLICTING','STALE'].includes(a.status)).map(a => para(`${a.id} · ${a.owner} · ${a.evidenceRequest}`)),
    ]}] });
  return Packer.toBuffer(doc);
}
