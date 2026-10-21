import { beforeEach,describe,expect,it,vi } from 'vitest';
import { anthropicResearch,loadWorkflow,RESEARCH_SECTIONS } from '../src/server/research/workflow';
import { testDeps } from './helpers/setup';
import type { Db } from '../src/server/db';

const mock=vi.hoisted(()=>({discover:vi.fn(),report:vi.fn()}));
vi.mock('@anthropic-ai/sdk',()=>({default:class {
  messages={create:mock.discover};beta={messages:{parse:mock.report}};
}}));
const snapshot={opportunity:{title:'Configured opportunity'},company:{name:'Selected Company'},sources:[],documents:[],assignments:[],approval:{estimatedCostUsd:3}};
function output():any{return {executiveSummary:'Current solicitation remains OPEN.',conditionalRecommendation:'G0 conditional screening only; human approval required.',sections:RESEARCH_SECTIONS.map(title=>({title,text:'Evidence remains open.',sourceIds:[]})),answers:loadWorkflow().questions.map(q=>({id:q.id,answer:'OPEN pending primary evidence',status:'OPEN',sourceIds:[],checkedOn:'2026-10-20',owner:'Capture owner',evidenceRequest:q.question,urgency:'high'})),capabilityMatrix:[],risks:[],nextActions:[],queryLog:[{query:'Model-invented search should be replaced',surface:'unverified',result:'unknown',checkedOn:'2026-10-20'}]};}
beforeEach(()=>{
  mock.discover.mockReset().mockResolvedValue({model:'approved-model',usage:{input_tokens:100,output_tokens:200},content:[
    {type:'server_tool_use',id:'search-1',name:'web_search',input:{query:'RFP-12345 current official solicitation'}},
    {type:'web_search_tool_result',tool_use_id:'search-1',content:[{type:'web_search_result',url:'https://sam.gov/opp/official-notice',title:'Official notice discovery'}]},
  ]});
  mock.report.mockReset().mockResolvedValue({model:'approved-model',usage:{input_tokens:300,output_tokens:400},parsed_output:output()});
});
describe('server-side skill orchestration with mocked Anthropic',()=>{
  it('loads the full skill, executes bounded public discovery, binds citations and records actual tool events and usage',async()=>{
    const deps=await testDeps({} as Db,undefined,{anthropicApiKey:'private-provider-key',anthropicModel:'approved-model'});
    const usage=vi.fn(async()=>undefined);
    const result=await anthropicResearch(deps,usage)(snapshot,loadWorkflow());
    const discovery=mock.discover.mock.calls[0][0],report=mock.report.mock.calls[0][0];
    expect(discovery.system).toContain('## F. Scope, technical and delivery fit');expect(discovery.system).toContain('VERIFIED_PRIMARY');
    expect(discovery.tools[0].max_uses).toBe(8);expect(discovery.tools[0].allowed_domains).not.toContain('g2x.com');
    expect(report.messages[0].content).toContain('Selected Company');expect(report.messages[0].content).toContain('requiredSectionTitles');
    expect(JSON.stringify([discovery,report])).not.toContain('private-provider-key');
    expect(result.sources[0].url).toBe('https://sam.gov/opp/official-notice');expect(result.report.queryLog[0].query).toBe('RFP-12345 current official solicitation');
    expect(result.usage.estimatedCostUsd).toBe(3);expect(usage).toHaveBeenCalledTimes(2);
  });
  it('fails closed when a model does not execute discovery, before charging a second request',async()=>{
    mock.discover.mockResolvedValue({model:'approved-model',usage:{input_tokens:100},content:[{type:'text',text:'An unsupported summary'}]});
    const usage=vi.fn(async()=>undefined),deps=await testDeps({} as Db,undefined,{anthropicApiKey:'test-key'});
    await expect(anthropicResearch(deps,usage)(snapshot,loadWorkflow())).rejects.toThrow('discovery did not execute');
    expect(mock.report).not.toHaveBeenCalled();expect(usage).toHaveBeenCalledTimes(1);
  });
  it('rejects invented citations and internal approvals while retaining usage for failed validation',async()=>{
    const invalid=output();invalid.answers[0].status='INTERNAL_APPROVED';invalid.answers[0].sourceIds=['invented-source'];
    mock.report.mockResolvedValue({model:'approved-model',usage:{input_tokens:300,output_tokens:400},parsed_output:invalid});
    const usage=vi.fn(async()=>undefined),deps=await testDeps({} as Db,undefined,{anthropicApiKey:'test-key'});
    await expect(anthropicResearch(deps,usage)(snapshot,loadWorkflow())).rejects.toThrow('unknown source');expect(usage).toHaveBeenCalledTimes(2);
  });
});
