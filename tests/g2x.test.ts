import crypto from 'node:crypto';
import { afterEach,describe,expect,it,vi } from 'vitest';
import { G2xClient,G2X_CAPABILITIES,G2X_ENDPOINT } from '../src/server/team/g2x';
import { createTestDb,testDeps } from './helpers/setup';
import { seal,unseal } from '../src/server/team/security';
import type { Db } from '../src/server/db';

vi.mock('../src/server/lib/urlSafety',()=>({assertPublicUrl:async(url:string)=>new URL(url)}));
const open:Db[]=[];
afterEach(async()=>{await Promise.all(open.splice(0).map(d=>d.close()));});
async function setup() {
  const db=await createTestDb();open.push(db);
  const user=crypto.randomUUID(),other=crypto.randomUUID();
  await db.query("INSERT INTO team_members(user_id,organization_id,email,name,role) SELECT $1,id,'g2x@test.gov','G2X member','member' FROM organizations LIMIT 1",[user]);
  const deps=await testDeps(db,undefined,{sessionSecret:'safe-server-side-credentials-secret',g2xEnabled:true});
  const calls:{url:string;body:any;headers:any}[]=[];
  let status=200;
  const request=vi.fn(async(input:any,init:any={})=>{
    const url=String(input),body=init.body ? (init.headers?.['Content-Type']==='application/json'?JSON.parse(init.body):Object.fromEntries(new URLSearchParams(init.body))) : null;
    calls.push({url,body,headers:init.headers});
    const response=(value:any,code=200,headers:any={'Content-Type':'application/json'})=>new Response(JSON.stringify(value),{status:code,headers});
    if(url.includes('oauth-protected-resource'))return response({resource:G2X_ENDPOINT,authorization_servers:['https://auth.g2x.com']});
    if(url.includes('oauth-authorization-server'))return response({issuer:'https://auth.g2x.com',authorization_endpoint:'https://auth.g2x.com/authorize',token_endpoint:'https://auth.g2x.com/token',registration_endpoint:'https://mcp.g2x.com/oauth/register',code_challenge_methods_supported:['S256']});
    if(url.endsWith('/register'))return response({client_id:'govcheck-client',token_endpoint_auth_method:'none'});
    if(url.endsWith('/token'))return response({access_token:'private-access',refresh_token:'private-refresh',expires_in:3600});
    if(status!==200)return response({},status);
    if(body.method==='notifications/initialized')return new Response(null,{status:202});
    const result=body.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}}}:body.method==='tools/list'?{tools:[{name:'official_read',inputSchema:{type:'object'},annotations:{readOnlyHint:true}}]}:{content:[{type:'text',text:'Individual research'}]};
    // Exercise both MCP transports.
    if(body.method==='tools/list')return new Response(`event: message\ndata: ${JSON.stringify({jsonrpc:'2.0',id:body.id,result})}\n\n`,{headers:{'Content-Type':'text/event-stream'}});
    return response({jsonrpc:'2.0',id:body.id,result});
  }) as unknown as typeof fetch;
  return {db,user,other,calls,client:new G2xClient(deps,request),setStatus:(value:number)=>{status=value;}};
}
describe('G2X research OAuth and token isolation',()=>{
  it('discovers issuer, uses PKCE and resource binding, stores encrypted tokens, discovers tools and refuses state replay',async()=>{
    const {client,user,db,calls}=await setup();
    const auth=new URL(await client.connect(user));expect(auth.searchParams.get('code_challenge_method')).toBe('S256');expect(auth.searchParams.get('resource')).toBe(G2X_ENDPOINT);
    await client.accept(user,auth.searchParams.get('state')!,'authorization-code');
    const row=await db.one('SELECT credentials FROM g2x_connections WHERE user_id=$1',[user]);expect(row.credentials).not.toContain('private-access');expect(unseal('safe-server-side-credentials-secret',row.credentials).refresh_token).toBe('private-refresh');
    expect((await client.tools(user))[0].name).toBe('official_read');
    const exchange=calls.find(c=>c.body?.grant_type==='authorization_code')!;expect(exchange.body.code_verifier).toBeTruthy();expect(exchange.body.resource).toBe(G2X_ENDPOINT);
    const rpc=calls.filter(c=>c.body?.jsonrpc);expect(rpc.every(c=>c.url===G2X_ENDPOINT)).toBe(true);expect(rpc.every(c=>c.headers.Authorization==='Bearer private-access')).toBe(true);
    await expect(client.accept(user,auth.searchParams.get('state')!,'replay')).rejects.toThrow('expired, reused');
    await client.connect(user);expect(calls.filter(c=>c.url.endsWith('/register'))).toHaveLength(1);
  });
  it('rotates refresh tokens once under concurrent calls and expires OAuth state',async()=>{
    const {client,user,db,calls}=await setup();
    const auth=new URL(await client.connect(user));await client.accept(user,auth.searchParams.get('state')!,'code');
    const row=await db.one('SELECT credentials FROM g2x_connections WHERE user_id=$1',[user]);
    const credentials=unseal('safe-server-side-credentials-secret',row.credentials);credentials.expires_at=0;
    await db.query('UPDATE g2x_connections SET credentials=$2 WHERE user_id=$1',[user,seal('safe-server-side-credentials-secret',credentials)]);
    await Promise.all([client.token(user),client.token(user)]);
    expect(calls.filter(c=>c.body?.grant_type==='refresh_token')).toHaveLength(1);
    const expired=new URL(await client.connect(user));await db.query("UPDATE oauth_states SET expires_at=now()-interval '1 minute'");
    await expect(client.accept(user,expired.searchParams.get('state')!,'code')).rejects.toThrow('expired');
    await client.disconnect(user);await expect(client.token(user)).rejects.toThrow('Connect your G2X');
  });
  it('binds state and credentials to the authorized user and handles entitlement and throttling',async()=>{
    const {client,user,other,setStatus}=await setup();
    const auth=new URL(await client.connect(user));
    await expect(client.accept(other,auth.searchParams.get('state')!,'code')).rejects.toThrow('another account');
    await expect(client.token(other)).rejects.toThrow('Connect your G2X');
    await client.accept(user,auth.searchParams.get('state')!,'code');
    for(const [status,message] of [[401,'Reconnect'],[403,'not entitled'],[429,'limit reached']] as const){setStatus(status);await expect(client.tools(user)).rejects.toThrow(message);}
    expect(G2X_CAPABILITIES).toEqual({automatedRefreshAuthorized:false,persistenceAuthorized:false,teamSharingAuthorized:false});
  });
});
