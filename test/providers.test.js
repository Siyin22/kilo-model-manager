'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const api = require('../providers');
test('routing and credentials honor local destinations, Chinese services, saved auth and env references', () => {
  for (const host of ['localhost','127.0.0.1','10.0.0.3','172.20.0.1','192.168.1.1','::1','fd01::1']) assert.equal(api.local(host),true);
  assert.equal(api.local('172.200.1.1'),false); assert.equal(api.domestic('api.deepseek.com'),true); assert.equal(api.domestic('api.openai.com'),false);
  const connection=api.connection({options:{baseURL:'https://example.com/v1',apiKey:'{env:KEY}'}},'test',{}, {KEY:'fake-key'});
  assert.equal(connection.url.href,'https://example.com/v1/models'); assert.equal(connection.headers.Authorization,'Bearer fake-key');
  assert.equal(api.connection({options:{baseURL:'https://example.com/v1'}},'test',{test:{type:'api',key:'stored'}}).headers.Authorization,'Bearer stored');
  assert.throws(()=>api.connection({options:{baseURL:'https://example.com',apiKey:'bad\nheader'}},'test'),/非法/);
});
test('real local HTTP discovery uses GET and headers, deduplicates models and does not follow redirects', async () => {
  let calls=0;
  const server=http.createServer((req,res)=>{
    calls++; assert.equal(req.method,'GET'); assert.equal(req.headers.authorization,'Bearer fake');
    if(req.url==='/redirect/models'){res.writeHead(302,{Location:'/v1/models'});res.end();return;}
    res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({data:[{id:'m2'},{id:'m1',name:'Model 1'},{id:'m2'}]}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const provider={options:{baseURL:`http://127.0.0.1:${server.address().port}/v1`,apiKey:'fake'}};
    assert.deepEqual(await api.fetchModels(provider,'test',{auth:{}}),[{id:'m1',name:'Model 1'},{id:'m2',name:'m2'}]);
    provider.options.baseURL=provider.options.baseURL.replace('/v1','/redirect');
    await assert.rejects(api.fetchModels(provider,'test',{auth:{}}),/HTTP 302/);
    assert.equal(calls,2);
  } finally {await new Promise(resolve=>server.close(resolve));}
});
test('proxy network errors retry directly; HTTP authorization errors do not retry', async () => {
  const provider={options:{baseURL:'https://example.com/v1'}};
  const routes=[];
  const models=await api.fetchModels(provider,'test',{auth:{},useProxy:async()=>true,request:async(url,headers,proxy)=>{
    routes.push(proxy); if(proxy)throw Object.assign(Error('connection failed'),{network:true});return {data:[{id:'m'}]};
  }});
  assert.deepEqual(routes,[true,false]);assert.equal(models[0].id,'m');
  let calls=0;
  await assert.rejects(api.fetchModels(provider,'test',{auth:{},useProxy:async()=>true,request:async()=>{calls++;throw Error('HTTP 401');}}),/401/);
  assert.equal(calls,1);
});
test('Anthropic pagination uses cursor and key header and rejects a repeated cursor', async () => {
  const provider={npm:'@ai-sdk/anthropic',options:{baseURL:'https://example.com/v1',apiKey:'fake'}};
  let calls=0;
  const models=await api.fetchModels(provider,'test',{auth:{},useProxy:async()=>false,request:async(url,headers)=>{
    assert.equal(headers['x-api-key'],'fake'); assert.equal(headers.Authorization,undefined); calls++;
    if(calls===1)return {data:[{id:'a'}],has_more:true,last_id:'a'};
    assert.equal(url.searchParams.get('after_id'),'a');return {data:[{id:'b'}],has_more:false};
  }});
  assert.equal(models.length,2);
  await assert.rejects(api.fetchModels(provider,'test',{auth:{},useProxy:async()=>false,request:async()=>({data:[{id:'a'}],has_more:true,last_id:'a'})}),/游标/);
});
