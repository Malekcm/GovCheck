import crypto from 'node:crypto';
import type { Hono } from 'hono';
import { z } from 'zod';
import { HttpProblem, readJson, type AppDeps } from '../app';
import { actor, digest, seal, unseal } from './security';
import { assertPublicUrl } from '../lib/urlSafety';
import { json } from '../db';

export const G2X_ENDPOINT = 'https://mcp.g2x.com/mcp/research';
export const G2X_CAPABILITIES = { automatedRefreshAuthorized:false,persistenceAuthorized:false,teamSharingAuthorized:false } as const;
export type G2xFetch = typeof fetch;
export class G2xClient {
  private protocols=new Map<string,string>();
  constructor(private deps:AppDeps, private request:G2xFetch=fetch) {}
  async http(url:string, init:RequestInit={}) {
    const parsed = await assertPublicUrl(url);
    if (parsed.protocol !== 'https:') throw new HttpProblem(503,'G2X discovery must use HTTPS.');
    let res:Response;
    try {res=await this.request(url,{...init,redirect:'error',signal:AbortSignal.timeout(30_000)});}
    catch {throw new HttpProblem(503,'G2X connection failed or timed out. Retry interactive research later.');}
    if ([401,403,429].includes(res.status)) throw new HttpProblem(res.status as 401|403|429,res.status===401 ? 'Reconnect your G2X account.' : res.status===403 ? 'Your G2X account is not entitled to this research.' : 'G2X request limit reached. Retry later.');
    if (!res.ok) throw new HttpProblem(503,'G2X is unavailable. Government-source research remains available.');
    let text='';
    if(res.body) {
      const reader=res.body.getReader(),decoder=new TextDecoder();let size=0;
      while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;if(size>2_000_000){await reader.cancel();throw new HttpProblem(503,'G2X response exceeded the interactive size limit.');}text+=decoder.decode(chunk.value,{stream:true});}
      text+=decoder.decode();
    }
    try {
    if (res.headers.get('content-type')?.includes('text/event-stream')) {
      const events = text.split(/\r?\n\r?\n/).flatMap(event => {
        const data=event.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');
        return data ? [JSON.parse(data)] : [];
      });
      return events.find(e=>e.id!=null) ?? {};
    }
    return text ? JSON.parse(text) : {};
    } catch {
      // JSON parser exceptions can include response fragments containing OAuth credentials.
      throw new HttpProblem(503,'G2X returned invalid protocol data. Retry or reconnect your account.');
    }
  }
  async discover() {
    const resource = await this.http('https://mcp.g2x.com/.well-known/oauth-protected-resource/mcp/research');
    if (resource.resource !== G2X_ENDPOINT || !resource.authorization_servers?.length) throw new HttpProblem(503,'Invalid G2X protected-resource metadata.');
    const issuer = new URL(resource.authorization_servers[0]);
    const metadataUrl = `${issuer.origin}/.well-known/oauth-authorization-server${issuer.pathname === '/' ? '' : issuer.pathname}`;
    const meta = await this.http(metadataUrl);
    if (meta.issuer !== issuer.toString().replace(/\/$/, '') && meta.issuer !== issuer.toString()) throw new HttpProblem(503,'G2X issuer mismatch.');
    for (const key of ['authorization_endpoint','token_endpoint']) if (!meta[key] || new URL(meta[key]).origin !== issuer.origin) throw new HttpProblem(503,'G2X authorization and token endpoints must belong to the discovered issuer.');
    // Current G2X metadata delegates registration to the MCP host, separate from its Clerk issuer.
    if(!meta.registration_endpoint || ![issuer.origin,'https://mcp.g2x.com'].includes(new URL(meta.registration_endpoint).origin)) throw new HttpProblem(503,'Untrusted G2X registration endpoint.');
    if (!meta.code_challenge_methods_supported?.includes('S256')) throw new HttpProblem(503,'G2X authorization server must support S256 PKCE.');
    return meta;
  }
  callback() { return `${this.deps.config.appBaseUrl}/api/g2x/callback`; }
  async connect(userId:string) {
    const meta = await this.discover();
    // Register once across processes; explicit configured client ID is also supported.
    const clientId = await this.deps.db.tx(async tx => {
      await tx.query('SELECT id FROM organizations ORDER BY id LIMIT 1 FOR UPDATE');
      const key = `g2x-client:${meta.issuer}:${this.callback()}`;
      const old = await tx.one('SELECT value FROM app_state WHERE key=$1',[key]);
      if (this.deps.config.g2xClientId || old) return this.deps.config.g2xClientId ?? old.value.client_id;
      const client = await this.http(meta.registration_endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_name:'GovCheck interactive research',redirect_uris:[this.callback()],grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none'})});
      if (!client.client_id || (client.token_endpoint_auth_method && client.token_endpoint_auth_method !== 'none')) throw new HttpProblem(503,'G2X public client registration failed.');
      await tx.query('INSERT INTO app_state(key,value) VALUES ($1,$2::jsonb)',[key,json({client_id:client.client_id})]);
      return client.client_id;
    });
    const state=crypto.randomBytes(32).toString('base64url'),verifier=crypto.randomBytes(48).toString('base64url');
    await this.deps.db.query('DELETE FROM oauth_states WHERE expires_at<now()');
    await this.deps.db.query("INSERT INTO oauth_states(state,user_id,verifier,metadata,expires_at) VALUES ($1,$2,$3,$4::jsonb,now()+interval '10 minutes')",[digest(state),userId,seal(this.deps.config.sessionSecret,verifier),json({...meta,client_id:clientId})]);
    const url=new URL(meta.authorization_endpoint);
    url.search=new URLSearchParams({client_id:clientId,response_type:'code',redirect_uri:this.callback(),scope:'openid offline_access',state,code_challenge:crypto.createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',resource:G2X_ENDPOINT}).toString();
    return url.toString();
  }
  async accept(userId:string,state:string,code:string) {
    const row=await this.deps.db.one('DELETE FROM oauth_states WHERE state=$1 AND user_id=$2 AND expires_at>now() RETURNING *',[digest(state),userId]);
    if (!row) throw new HttpProblem(400,'G2X sign-in state expired, reused, or belongs to another account.');
    const meta=await this.discover();
    if (meta.issuer!==row.metadata.issuer || meta.token_endpoint!==row.metadata.token_endpoint) throw new HttpProblem(400,'G2X authorization metadata changed. Restart connection.');
    const tokens=await this.http(meta.token_endpoint,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',code,client_id:row.metadata.client_id,redirect_uri:this.callback(),code_verifier:unseal(this.deps.config.sessionSecret,row.verifier),resource:G2X_ENDPOINT})});
    if (!tokens.access_token) throw new HttpProblem(401,'G2X did not return an access token.');
    const credentials={...tokens,issuer:meta.issuer,client_id:row.metadata.client_id,expires_at:Date.now()+Number(tokens.expires_in ?? 300)*1000};
    await this.deps.db.query('INSERT INTO g2x_connections(user_id,credentials) VALUES ($1,$2) ON CONFLICT(user_id) DO UPDATE SET credentials=EXCLUDED.credentials,updated_at=now()',[userId,seal(this.deps.config.sessionSecret,credentials)]);
    await this.tools(userId);
  }
  async token(userId:string) {
    return this.deps.db.tx(async tx => {
      const row=await tx.one('SELECT credentials FROM g2x_connections WHERE user_id=$1 FOR UPDATE',[userId]);
      if (!row) throw new HttpProblem(401,'Connect your G2X account first.');
      let credentials=unseal(this.deps.config.sessionSecret,row.credentials);
      if (credentials.expires_at<Date.now()+60_000) {
        if (!credentials.refresh_token) throw new HttpProblem(401,'Reconnect G2X; no refresh token is available.');
        const meta=await this.discover();
        if(meta.issuer!==credentials.issuer) throw new HttpProblem(401,'G2X issuer changed. Reconnect.');
        const refresh=await this.http(meta.token_endpoint,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:credentials.client_id,refresh_token:credentials.refresh_token,resource:G2X_ENDPOINT})});
        if(!refresh.access_token) throw new HttpProblem(401,'Reconnect G2X; token refresh failed.');
        credentials={...credentials,...refresh,expires_at:Date.now()+Number(refresh.expires_in ?? 300)*1000};
        await tx.query('UPDATE g2x_connections SET credentials=$2,updated_at=now() WHERE user_id=$1',[userId,seal(this.deps.config.sessionSecret,credentials)]);
      }
      return credentials.access_token as string;
    });
  }
  async rpc(userId:string,method:string,params:unknown={},notification=false) {
    const access=await this.token(userId);
    const id=crypto.randomUUID();
    const data=await this.http(G2X_ENDPOINT,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',Authorization:`Bearer ${access}`,'MCP-Protocol-Version':this.protocols.get(userId)??'2025-03-26'},body:JSON.stringify({jsonrpc:'2.0',...(notification ? {} : {id}),method,params})});
    if(!notification&&data.id!==id)throw new HttpProblem(503,'G2X response did not match this research request.');
    if(data.error) throw new HttpProblem(422,'G2X rejected this research request. Check tool inputs and account entitlement.');
    if(data.result?.isError)throw new HttpProblem(422,'G2X could not complete this tool call. Check the discovered tool schema and your account entitlement.');
    return data.result;
  }
  async tools(userId:string) {
    const initialized=await this.rpc(userId,'initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'GovCheck',version:'2.0.0'}});
    if(!/^\d{4}-\d{2}-\d{2}$/.test(initialized?.protocolVersion??''))throw new HttpProblem(503,'Invalid G2X protocol negotiation.');
    this.protocols.set(userId,initialized.protocolVersion);
    await this.rpc(userId,'notifications/initialized',{},true);
    const tools:any[]=[];
    let cursor:string|undefined;
    for(let page=0;page<10;page++) {
      const result=await this.rpc(userId,'tools/list',cursor ? {cursor} : {});
      tools.push(...(result?.tools ?? [])); cursor=result?.nextCursor;
      if(!cursor) return tools;
    }
    throw new HttpProblem(503,'G2X tool discovery exceeded its page limit.');
  }
  async disconnect(userId:string) {
    const row=await this.deps.db.one('SELECT credentials FROM g2x_connections WHERE user_id=$1',[userId]);
    let revoked=false;
    if(row)try {
      const credentials=unseal(this.deps.config.sessionSecret,row.credentials),meta=await this.discover();
      if(meta.issuer===credentials.issuer&&meta.revocation_endpoint&&new URL(meta.revocation_endpoint).origin===new URL(meta.issuer).origin) {
        await this.http(meta.revocation_endpoint,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token:credentials.refresh_token??credentials.access_token,client_id:credentials.client_id,token_type_hint:credentials.refresh_token?'refresh_token':'access_token'})});revoked=true;
      }
    }catch { /* Local disconnection always succeeds even when the provider is unavailable. */ }
    await this.deps.db.query('DELETE FROM g2x_connections WHERE user_id=$1',[userId]);
    this.protocols.delete(userId);
    return {ok:true,revoked,message:revoked?'G2X disconnected and credentials revoked.':'G2X disconnected locally. If required, revoke GovCheck access in your G2X account.'};
  }
}
export function registerG2xRoutes(app:Hono,deps:AppDeps) {
  const client=new G2xClient(deps);
  const enabled=()=>{if(!deps.config.g2xEnabled) throw new HttpProblem(503,'G2X interactive research is disabled pending account and integration authorization.');};
  app.get('/api/g2x/status',async c=>c.json({interactiveResearchEnabled:deps.config.g2xEnabled,...G2X_CAPABILITIES,connected:!!await deps.db.one('SELECT 1 FROM g2x_connections WHERE user_id=$1',[actor(c)!.user_id])}));
  app.post('/api/g2x/connect',async c=>{enabled();return c.json({url:await client.connect(actor(c)!.user_id)});});
  app.get('/api/g2x/callback',async c=>{
    enabled();
    await client.accept(actor(c)!.user_id,z.string().min(20).max(500).parse(c.req.query('state')),z.string().min(1).max(4000).parse(c.req.query('code')));
    c.header('Referrer-Policy','no-referrer');
    return c.redirect('/integrations');
  });
  app.post('/api/g2x/disconnect',async c=>c.json(await client.disconnect(actor(c)!.user_id)));
  app.get('/api/g2x/tools',async c=>{enabled();return c.json(await client.tools(actor(c)!.user_id));});
  app.post('/api/g2x/research',async c=>{
    enabled();
    if(actor(c)!.role==='viewer') throw new HttpProblem(403,'Viewers cannot initiate research.');
    const b=z.object({tool:z.string().max(150),arguments:z.record(z.string(),z.unknown()),acknowledgeIndividualUse:z.literal(true)}).strict().parse(await readJson(c));
    const tool=(await client.tools(actor(c)!.user_id)).find(t=>t.name===b.tool);
    if(!tool || tool.annotations?.readOnlyHint!==true) throw new HttpProblem(403,'Only discovered tools explicitly annotated read-only can run.');
    // The research-only endpoint is the independent server-side action boundary.
    return c.json({result:await client.rpc(actor(c)!.user_id,'tools/call',{name:b.tool,arguments:b.arguments}),retention:'Individual interactive session only. Do not persist, share, or send these results to another AI provider.'});
  });
}
