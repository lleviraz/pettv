import { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { WebView } from 'react-native-webview';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { router } from 'expo-router';
import { ref, onValue } from 'firebase/database';
import { auth, db, DB_URL } from '../config';

function buildViewerHtml(idToken, myUid) {
  return `<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#000;overflow:hidden;font-family:sans-serif}
video{width:100vw;height:100vh;object-fit:cover}
#st{position:fixed;top:40%;left:0;right:0;text-align:center;color:#fff;font-size:16px;padding:12px}
</style>
</head>
<body>
<video id="v" autoplay playsinline></video>
<div id="st">Connecting...</div>
<script>
const TOKEN='${idToken}';
const UID='${myUid}';
const DB='${DB_URL}';
const ICE=[{urls:'stun:stun.l.google.com:19302'},{urls:'stun:stun1.l.google.com:19302'}];

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

let started=false;
async function connect(){
  st('Requesting stream...');
  await dbw('/sessions/'+UID+'.json','PUT',{request:true});
  st('Waiting for home phone...');

  sse('/sessions/'+UID+'/offer.json',(type,path,offerSdp)=>{
    if(typeof offerSdp!=='string'||started)return;
    started=true;
    startPc(offerSdp).catch(e=>st('Error: '+e.message));
  });
}

async function startPc(offerSdp){
  st('Creating connection...');
  const pc=new RTCPeerConnection({iceServers:ICE});

  pc.ontrack=e=>{
    if(e.streams&&e.streams[0]){
      document.getElementById('v').srcObject=e.streams[0];
      document.getElementById('st').style.display='none';
      if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(JSON.stringify({t:'connected'}));
    }
  };

  pc.onconnectionstatechange=()=>{
    const s=pc.connectionState;
    if(s==='failed'||s==='disconnected'||s==='closed'){
      st('Connection lost');
      if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(JSON.stringify({t:'lost'}));
    }
  };

  pc.onicecandidate=({candidate})=>{
    if(candidate){
      dbw('/sessions/'+UID+'/ice_viewer.json','POST',candidate.toJSON()).catch(()=>{});
    }
  };

  await pc.setRemoteDescription({type:'offer',sdp:offerSdp});
  const answer=await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await dbw('/sessions/'+UID+'/answer.json','PUT',answer.sdp);
  st('Waiting for stream...');

  const added=new Set();
  sse('/sessions/'+UID+'/ice_home.json',(type,path,data)=>{
    for(const[k,c]of kids(type,path,data)){
      if(!added.has(k)&&c&&c.candidate){
        added.add(k);
        pc.addIceCandidate(c).catch(()=>{});
      }
    }
  });
}

connect().catch(e=>st('Fatal: '+e.message));
</script>
</body>
</html>`;
}

export default function ViewerModeScreen() {
  const [phase, setPhase] = useState('idle');
  const [homeOnline, setHomeOnline] = useState(null);
  const [statusMsg, setStatusMsg] = useState('');
  const [idToken, setIdToken] = useState(null);
  const myUid = auth.currentUser?.uid;

  useEffect(() => {
    const hbUnsub = onValue(ref(db, '/heartbeat'), (snap) => {
      setHomeOnline(snap.exists());
    });
    auth.currentUser?.getIdToken(true).then(setIdToken).catch(() => {});
    return () => hbUnsub();
  }, []);

  function onMessage(e) {
    try {
      const msg = JSON.parse(e.nativeEvent.data);
      if (msg.t === 's') setStatusMsg(msg.m);
      else if (msg.t === 'connected') { setPhase('connected'); setStatusMsg(''); }
      else if (msg.t === 'lost') { setPhase('error'); setStatusMsg('Connection lost'); }
    } catch {}
  }

  async function disconnect() {
    setPhase('idle');
    setStatusMsg('');
  }

  async function switchRole() {
    await AsyncStorage.removeItem('role');
    router.replace('/role-picker');
  }

  if ((phase === 'connecting' || phase === 'connected') && idToken) {
    return (
      <View style={styles.fullscreen}>
        <WebView
          source={{ html: buildViewerHtml(idToken, myUid), baseUrl: 'https://localhost' }}
          style={styles.video}
          javaScriptEnabled={true}
          domStorageEnabled={true}
          mediaPlaybackRequiresUserAction={false}
          allowsInlineMediaPlayback={true}
          originWhitelist={['*']}
          onMessage={onMessage}
        />
        <TouchableOpacity style={styles.disconnectBtn} onPress={disconnect}>
          <Text style={styles.disconnectText}>✕ Disconnect</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.emoji}>📱</Text>
      <Text style={styles.title}>PetTV</Text>

      {homeOnline === null && <ActivityIndicator color="#4A90E2" />}

      {homeOnline === false && (
        <Text style={styles.offlineText}>Home phone is offline</Text>
      )}

      {homeOnline === true && phase === 'idle' && (
        <TouchableOpacity
          style={styles.connectBtn}
          onPress={() => { if (idToken) setPhase('connecting'); }}
        >
          <Text style={styles.connectText}>▶  Watch Live</Text>
        </TouchableOpacity>
      )}

      {phase === 'connecting' && !idToken && <ActivityIndicator color="#4A90E2" />}

      {phase === 'error' && (
        <>
          <Text style={styles.errorText}>Connection failed</Text>
          {!!statusMsg && <Text style={styles.errorDetail}>{statusMsg}</Text>}
          <TouchableOpacity style={styles.connectBtn} onPress={() => setPhase('connecting')}>
            <Text style={styles.connectText}>Retry</Text>
          </TouchableOpacity>
        </>
      )}

      <TouchableOpacity style={styles.switchBtn} onPress={switchRole}>
        <Text style={styles.switchText}>Switch role</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  fullscreen: { flex: 1, backgroundColor: '#000' },
  video: { flex: 1 },
  disconnectBtn: {
    position: 'absolute',
    top: 48,
    right: 20,
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
  },
  disconnectText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#F0FFF4',
    paddingHorizontal: 24,
    gap: 16,
  },
  emoji: { fontSize: 48 },
  title: { fontSize: 32, fontWeight: '700', color: '#1a1a1a' },
  offlineText: { fontSize: 15, color: '#888' },
  connectBtn: {
    paddingHorizontal: 36,
    paddingVertical: 16,
    borderRadius: 14,
    backgroundColor: '#27ae60',
  },
  connectText: { color: '#fff', fontSize: 18, fontWeight: '700' },
  errorText: { fontSize: 15, color: '#c0392b', fontWeight: '600' },
  errorDetail: { fontSize: 12, color: '#888', textAlign: 'center', paddingHorizontal: 16 },
  switchBtn: { position: 'absolute', bottom: 36 },
  switchText: { fontSize: 13, color: '#aaa' },
});
