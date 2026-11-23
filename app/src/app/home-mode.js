import { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, StatusBar } from 'react-native';
import { WebView } from 'react-native-webview';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { router } from 'expo-router';
import { ref, remove } from 'firebase/database';
import { auth, db, DB_URL } from '../config';

function buildHomeHtml(idToken, uid) {
  return `<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#000;overflow:hidden;font-family:sans-serif}
video{width:100vw;height:100vh;object-fit:cover;transform:scaleX(-1)}
#st{position:fixed;top:16px;left:10px;right:10px;color:#fff;font-size:14px;font-weight:600;background:rgba(0,0,0,0.55);padding:6px 10px;border-radius:6px;pointer-events:none}
</style>
</head>
<body>
<video id="v" autoplay playsinline muted></video>
<div id="st">Starting...</div>
<script>
const TOKEN='${idToken}';
const UID='${uid}';
const DB='${DB_URL}';
const ICE=[{urls:'stun:stun.l.google.com:19302'},{urls:'stun:stun1.l.google.com:19302'}];
const pcs={};
const answerListeners={};
const iceListeners={};

function st(msg){
  document.getElementById('st').textContent=msg;
  if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(JSON.stringify({t:'s',m:msg}));
}

async function dbw(path,method,data){
  const r=await fetch(DB+path+'?auth='+TOKEN,{
    method:method||'GET',
    headers:{'Content-Type':'application/json'},
    ...(data!==undefined?{body:JSON.stringify(data)}:{})
  });
  if(!r.ok)throw new Error('DB '+method+' '+path+' '+r.status+' '+(await r.text()));
  return r.json();
}

function sse(path,cb){
  const es=new EventSource(DB+path+'?auth='+TOKEN);
  es.addEventListener('put',e=>{try{const d=JSON.parse(e.data);cb('put',d.path,d.data);}catch(_){}});
  es.addEventListener('patch',e=>{try{const d=JSON.parse(e.data);cb('patch',d.path,d.data);}catch(_){}});
  es.addEventListener('cancel',e=>st('Listen denied: '+path+' '+e.data));
  return es;
}

// Firebase SSE reports changes relative to the listened path; returns changed top-level children
function kids(type,path,data){
  const p=path.split('/').filter(Boolean);
  if(p.length===0)return data&&typeof data==='object'?Object.entries(data):[];
  if(p.length===1&&type==='put')return [[p[0],data]];
  return [];
}

async function start(){
  st('Starting camera...');
  let stream;
  try{
    stream=await navigator.mediaDevices.getUserMedia({
      audio:true,
      video:{facingMode:'user',width:{ideal:640},height:{ideal:480},frameRate:{ideal:15}}
    });
  }catch(e){
    st('Camera error: '+e.message);
    return;
  }
  document.getElementById('v').srcObject=stream;
  st('Online');

  try{
    await dbw('/sessions.json','DELETE');
    await dbw('/heartbeat.json','PUT',{ts:Date.now(),uid:UID});
  }catch(e){st(e.message);return;}

  sse('/sessions.json',(type,path,data)=>{
    for(const[vid,session]of kids(type,path,data)){
      if(session&&session.request&&!pcs[vid]){
        handleViewer(vid,stream).catch(e=>st('Viewer err: '+e.message));
      }
    }
  });
}

async function handleViewer(vid,stream){
  const pc=new RTCPeerConnection({iceServers:ICE});
  pcs[vid]=pc;
  stream.getTracks().forEach(t=>pc.addTrack(t,stream));

  pc.onicecandidate=({candidate})=>{
    if(candidate){
      dbw('/sessions/'+vid+'/ice_home.json','POST',candidate.toJSON()).catch(()=>{});
    }
  };

  pc.onconnectionstatechange=()=>{
    const s=pc.connectionState;
    if(s==='connected'){
      const n=Object.keys(pcs).length;
      st(n+' viewer'+(n!==1?'s':'')+' watching');
      if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(JSON.stringify({t:'vc',n}));
    }else if(s==='failed'||s==='closed'||s==='disconnected'){
      delete pcs[vid];
      if(answerListeners[vid]){answerListeners[vid].close();delete answerListeners[vid];}
      if(iceListeners[vid]){iceListeners[vid].close();delete iceListeners[vid];}
      const n=Object.keys(pcs).length;
      st(n>0?n+' viewer'+(n!==1?'s':'')+' watching':'Online');
      if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(JSON.stringify({t:'vc',n}));
    }
  };

  const offer=await pc.createOffer();
  await pc.setLocalDescription(offer);
  await dbw('/sessions/'+vid+'/offer.json','PUT',offer.sdp);

  const pending=[];
  let answered=false;
  answerListeners[vid]=sse('/sessions/'+vid+'/answer.json',async(type,path,data)=>{
    if(typeof data!=='string'||answered)return;
    answered=true;
    try{
      await pc.setRemoteDescription({type:'answer',sdp:data});
      pending.splice(0).forEach(c=>pc.addIceCandidate(c).catch(()=>{}));
    }catch(e){st('Answer err: '+e.message);}
  });

  const added=new Set();
  iceListeners[vid]=sse('/sessions/'+vid+'/ice_viewer.json',(type,path,data)=>{
    for(const[k,c]of kids(type,path,data)){
      if(!added.has(k)&&c&&c.candidate){
        added.add(k);
        if(pc.remoteDescription)pc.addIceCandidate(c).catch(()=>{});
        else pending.push(c);
      }
    }
  });
}

start().catch(e=>st('Fatal: '+e.message));
</script>
</body>
</html>`;
}

export default function HomeModeScreen() {
  const [idToken, setIdToken] = useState(null);
  const [status, setStatus] = useState('Loading...');
  const [viewerCount, setViewerCount] = useState(0);
  const uid = auth.currentUser?.uid;

  useEffect(() => {
    auth.currentUser?.getIdToken(true)
      .then(setIdToken)
      .catch(e => setStatus('Auth error: ' + (e?.message ?? String(e))));
    return () => {
      remove(ref(db, '/heartbeat')).catch(() => {});
      remove(ref(db, '/sessions')).catch(() => {});
    };
  }, []);

  async function stop() {
    await remove(ref(db, '/heartbeat')).catch(() => {});
    await remove(ref(db, '/sessions')).catch(() => {});
    await AsyncStorage.removeItem('role');
    router.replace('/role-picker');
  }

  function onMessage(e) {
    try {
      const msg = JSON.parse(e.nativeEvent.data);
      if (msg.t === 's') setStatus(msg.m);
      else if (msg.t === 'vc') setViewerCount(msg.n);
    } catch {}
  }

  if (!idToken) {
    return (
      <View style={styles.loading}>
        <StatusBar barStyle="light-content" backgroundColor="#000" />
        <Text style={styles.loadingText}>{status}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#000" />
      <WebView
        source={{ html: buildHomeHtml(idToken, uid), baseUrl: 'https://localhost' }}
        style={styles.webview}
        mediaPlaybackRequiresUserAction={false}
        allowsInlineMediaPlayback={true}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        originWhitelist={['*']}
        mixedContentMode="always"
        onPermissionRequest={(request) => { if (request.grant) request.grant(request.resources); }}
        onMessage={onMessage}
        allowFileAccessFromFileURLs={true}
        allowUniversalAccessFromFileURLs={true}
      />
      <View style={styles.bottomOverlay}>
        <View style={styles.statusRow}>
          <View style={styles.onlineDot} />
          <Text style={styles.statusText}>{status}</Text>
          {viewerCount > 0 && (
            <View style={styles.viewerBadge}>
              <Text style={styles.viewerText}>👁 {viewerCount}</Text>
            </View>
          )}
        </View>
        <TouchableOpacity style={styles.stopBtn} onPress={stop}>
          <Text style={styles.stopText}>Stop &amp; Switch Role</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  webview: { flex: 1 },
  loading: { flex: 1, backgroundColor: '#000', justifyContent: 'center', alignItems: 'center' },
  loadingText: { color: '#fff', fontSize: 16 },

  bottomOverlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingBottom: 48,
    paddingTop: 16,
    paddingHorizontal: 24,
    alignItems: 'center',
    gap: 12,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    alignSelf: 'stretch',
  },
  onlineDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: '#2ecc71' },
  statusText: { flex: 1, color: '#fff', fontSize: 15, fontWeight: '600' },
  viewerBadge: {
    backgroundColor: 'rgba(255,255,255,0.2)',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  viewerText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  stopBtn: {
    paddingHorizontal: 28,
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: 'rgba(192,57,43,0.85)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
    alignSelf: 'stretch',
    alignItems: 'center',
  },
  stopText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
