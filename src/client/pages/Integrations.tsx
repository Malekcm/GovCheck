import { useState } from 'react';
import { useMutation,useQuery,useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { Card,ErrorBox } from '../components/ui';

export function IntegrationsPage() {
  const qc=useQueryClient();
  const status=useQuery({queryKey:['g2x-status'],queryFn:()=>api.get<any>('/api/g2x/status')});
  const tools=useQuery({queryKey:['g2x-tools'],queryFn:()=>api.get<any[]>('/api/g2x/tools'),enabled:!!status.data?.connected&&!!status.data?.interactiveResearchEnabled});
  const [tool,setTool]=useState(''),[input,setInput]=useState('{}'),[result,setResult]=useState<any>(null);
  const connect=useMutation({mutationFn:()=>api.post<{url:string}>('/api/g2x/connect'),onSuccess:r=>window.location.assign(r.url)});
  const disconnect=useMutation({mutationFn:()=>api.post('/api/g2x/disconnect'),onSuccess:()=>{setResult(null);qc.removeQueries({queryKey:['g2x-tools']});qc.invalidateQueries({queryKey:['g2x-status']});}});
  const research=useMutation({mutationFn:()=>api.post('/api/g2x/research',{tool,arguments:JSON.parse(input),acknowledgeIndividualUse:true}),onSuccess:setResult});
  const selected=tools.data?.find(t=>t.name===tool);
  return <><h1>Integration settings</h1><Card title="G2X individual interactive research"><p>Connect your own G2X membership using OAuth. Content is limited to this page’s current session. Storage, team sharing, automated extraction and transfer to external AI providers are disabled.</p>
    <details open><summary>How to use G2X</summary><ol>
      <li>Select <strong>Connect G2X</strong>, sign in to your own G2X account, and approve the connection. You will return to GovCheck.</li>
      <li>Choose a <strong>Read-only research tool</strong>. The list depends on the tools and access included with your G2X account.</li>
      <li>Expand <strong>Required tool input schema</strong>. Enter a JSON object using that tool's required field names and values in <strong>Research inputs as JSON</strong>. For example, research the buyer or incumbent for an opportunity you are pursuing. Each tool has its own input fields.</li>
      <li>Select <strong>Run individual research</strong> and review the returned records and source links. Use <strong>Clear research results</strong> when finished. Results are not imported into opportunities or saved for teammates.</li>
    </ol><p>If G2X refuses a request, check your account's plan and permissions. Reconnect for an expired sign-in; wait before retrying a rate-limit error. <a href="https://g2x.com/mcp/tools" target="_blank" rel="noreferrer">G2X tool reference</a></p></details>
    <p>Interactive research: {status.data?.interactiveResearchEnabled?'Enabled':'Disabled pending authorization'} · {status.data?.connected?'Account connected':'No connected account'}</p>
    {[status.error,tools.error,connect.error,disconnect.error,research.error].filter(Boolean).map((e,i)=><ErrorBox key={i} error={e}/>)}
    <button className="btn" disabled={!status.data?.interactiveResearchEnabled||connect.isPending} onClick={()=>connect.mutate()}>Connect G2X</button>
    {status.data?.connected&&<button className="btn" disabled={disconnect.isPending} onClick={()=>disconnect.mutate()}>Disconnect G2X</button>}
    {!!tools.data?.length&&<><label className="field">Read-only research tool<select value={tool} onChange={e=>{setTool(e.target.value);setResult(null);setInput('{}');}}><option value="">Select a tool</option>{tools.data.filter(t=>t.annotations?.readOnlyHint===true).map(t=><option key={t.name} value={t.name}>{t.title??t.name}</option>)}</select></label>
      {selected&&<><p>{selected.description}</p><details><summary>Required tool input schema</summary><pre style={{whiteSpace:'pre-wrap'}}>{JSON.stringify(selected.inputSchema,null,2)}</pre></details><label className="field">Research inputs as JSON<textarea value={input} onChange={e=>setInput(e.target.value)} rows={8}/></label><button className="btn primary" disabled={research.isPending} onClick={()=>research.mutate()}>Run individual research</button></>}
    </>}
    {result&&<div><p>{result.retention}</p><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify(result.result,null,2)}</pre><button className="btn" onClick={()=>setResult(null)}>Clear research results</button></div>}
  </Card></>;
}
