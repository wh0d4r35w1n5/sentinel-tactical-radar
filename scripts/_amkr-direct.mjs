import './load-env.mjs';
import crypto from 'node:crypto';
const HOST='https://api.bitget.com', PRODUCT='USDT-FUTURES';
const key=process.env.BITGET_API_KEY, secret=process.env.BITGET_API_SECRET, pass=process.env.BITGET_PASSPHRASE;
function hdr(method,path,qs,bodyStr){
  const ts=String(Date.now());
  const pre=ts+method.toUpperCase()+path+(qs?'?'+qs:'')+(bodyStr||'');
  const sign=crypto.createHmac('sha256',secret).update(pre).digest('base64');
  return {'ACCESS-KEY':key,'ACCESS-SIGN':sign,'ACCESS-PASSPHRASE':pass,'ACCESS-TIMESTAMP':ts,'Content-Type':'application/json',locale:'en-US'};
}
async function call(method,path,{qs='',body=null}={}){
  const bodyStr=body?JSON.stringify(body):'';
  const res=await fetch(HOST+path+(qs?'?'+qs:''),{method,headers:hdr(method,path,qs,bodyStr),body:bodyStr||undefined});
  const j=await res.json().catch(()=>({}));
  if(!res.ok||(j.code&&j.code!=='00000')) throw new Error(path+' -> '+(j.code||res.status)+' '+(j.msg||''));
  return j.data;
}
// fresh account check
const acc=(await call('GET','/api/v2/mix/account/accounts',{qs:'productType='+PRODUCT})).find(a=>a.marginCoin==='USDT');
console.log('available',acc.available,'equity',acc.usdtEquity);
// buy 0.72 AMKR long, isolated, hedge mode -> side buy tradeSide open
const body={symbol:'AMKRUSDT',productType:PRODUCT,marginMode:'isolated',marginCoin:'USDT',size:'0.72',side:'buy',tradeSide:'open',orderType:'market',clientOid:('amkrm'+Date.now()).slice(0,38)};
const r=await call('POST','/api/v2/mix/order/place-order',{body});
console.log('ORDER',JSON.stringify(r));
