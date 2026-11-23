import { useEffect, useState } from 'react';
import { auth, DB_URL } from './config';

const TOKEN_REFRESH_MS = 45 * 60 * 1000;

// Browser-side Firebase RTDB REST/SSE helpers shared by the home and viewer WebView pages
export function signalingScript(idToken, uid) {
  return `
let TOKEN=${JSON.stringify(idToken)};
const UID=${JSON.stringify(uid)};
const DB=${JSON.stringify(DB_URL)};
const ICE=[{urls:'stun:stun.l.google.com:19302'},{urls:'stun:stun1.l.google.com:19302'}];
const tokenWaiters=[];
window.setToken=t=>{TOKEN=t;tokenWaiters.splice(0).forEach(f=>f());};

function post(o){if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(JSON.stringify(o));}
function st(msg){const el=document.getElementById('st');if(el)el.textContent=msg;post({t:'s',m:msg});}
function freshToken(){return new Promise(res=>{tokenWaiters.push(res);post({t:'needToken'});});}

async function dbw(path,method,data,retried){
  const r=await fetch(DB+path+'?auth='+TOKEN,{
    method:method||'GET',
    headers:{'Content-Type':'application/json'},
    ...(data!==undefined?{body:JSON.stringify(data)}:{})
  });
  if(r.status===401&&!retried){await freshToken();return dbw(path,method,data,true);}
  if(!r.ok)throw new Error('DB '+method+' '+path+' '+r.status+' '+(await r.text()));
  return r.json();
}

// Reopens with the current token when Firebase revokes an expired one or the stream dies
function sse(path,cb){
  let es,closed=false;
  function open(){
    es=new EventSource(DB+path+'?auth='+TOKEN);
    es.addEventListener('put',e=>{try{const d=JSON.parse(e.data);cb('put',d.path,d.data);}catch(_){}});
    es.addEventListener('patch',e=>{try{const d=JSON.parse(e.data);cb('patch',d.path,d.data);}catch(_){}});
    es.addEventListener('auth_revoked',()=>{es.close();freshToken().then(()=>{if(!closed)open();});});
    es.addEventListener('cancel',()=>st('Listen denied: '+path));
    es.onerror=()=>{if(es.readyState===EventSource.CLOSED&&!closed)setTimeout(open,3000);};
  }
  open();
  return {close(){closed=true;es.close();}};
}

// Firebase SSE reports changes relative to the listened path; returns changed top-level children
function kids(type,path,data){
  const p=path.split('/').filter(Boolean);
  if(p.length===0)return data&&typeof data==='object'?Object.entries(data):[];
  if(p.length===1&&type==='put')return [[p[0],data]];
  return [];
}
`;
}

// Firebase ID tokens expire after an hour; keeps the WebView supplied without reloading it
export function useSignalingToken(webRef) {
  const [token, setToken] = useState(null);
  const [error, setError] = useState(null);

  function pushFreshToken() {
    auth.currentUser?.getIdToken(true)
      .then(t => webRef.current?.injectJavaScript(`window.setToken(${JSON.stringify(t)});true;`))
      .catch(e => setError(e?.message ?? String(e)));
  }

  useEffect(() => {
    auth.currentUser?.getIdToken()
      .then(setToken)
      .catch(e => setError(e?.message ?? String(e)));
    const timer = setInterval(pushFreshToken, TOKEN_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  return { token, error, pushFreshToken };
}
