import { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, StatusBar } from 'react-native';
import { WebView } from 'react-native-webview';
import { useKeepAwake } from 'expo-keep-awake';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { router } from 'expo-router';
import { ref, remove, set, onValue, onDisconnect, serverTimestamp } from 'firebase/database';
import { auth, db } from '../config';
import { signalingScript, useSignalingToken } from '../webview-signaling';

function buildHomeHtml(idToken, uid) {
  return `<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#000;overflow:hidden;font-family:sans-serif}
video{width:100vw;height:100vh;object-fit:cover;transform:scaleX(-1)}
</style>
</head>
<body>
<video id="v" autoplay playsinline muted></video>
<script>
${signalingScript(idToken, uid)}
const viewers={};
const grants={};
const blocked={};
let stream;

function grantValid(vid){
  const g=grants[vid];
  return !!g&&g.redeemedAt+g.accessMs>Date.now();
}

function logEv(event,vid,name){
  dbw('/log.json','POST',{uid:UID,event,subject:vid,detail:name,ts:{'.sv':'timestamp'}}).catch(()=>{});
}

// Rules only block new requests; a stream already flowing must be cut here when access ends
function enforceAccess(){
  for(const[vid,v]of Object.entries(viewers)){
    if(blocked[vid]||(v.viaGrant&&!grantValid(vid))){
      closeViewer(vid);
      dbw('/sessions/'+vid+'.json','DELETE').catch(()=>{});
    }
  }
}

function mirror(target,type,path,data){
  if(type==='put'&&path==='/')Object.keys(target).forEach(k=>delete target[k]);
  for(const[k,val]of kids(type,path,data)){
    if(val)target[k]=val;else delete target[k];
  }
  enforceAccess();
}

function updateCount(){
  const names=Object.values(viewers).filter(v=>v.pc.connectionState==='connected').map(v=>v.name);
  const n=names.length;
  st(n>0?n+' viewer'+(n!==1?'s':'')+' watching':'Online');
  post({t:'viewers',names});
}

function closeViewer(vid){
  const v=viewers[vid];
  if(!v)return;
  delete viewers[vid];
  if(v.started)logEv('watch-stop',vid,v.label);
  v.listeners.forEach(l=>l.close());
  v.pc.close();
  updateCount();
}

async function start(){
  st('Starting camera...');
  try{
    stream=await navigator.mediaDevices.getUserMedia({
      audio:true,
      video:{facingMode:'user',width:{ideal:640},height:{ideal:480},frameRate:{ideal:15}}
    });
  }catch(e){st('Camera error: '+e.message);return;}
  document.getElementById('v').srcObject=stream;

  try{await dbw('/sessions.json','DELETE');}catch(e){st(e.message);return;}
  st('Online');
  post({t:'ready'});

  sse('/grants.json',(type,path,data)=>mirror(grants,type,path,data));
  sse('/blocked.json',(type,path,data)=>mirror(blocked,type,path,data));
  setInterval(enforceAccess,15000);

  sse('/sessions.json',(type,path,data)=>{
    for(const[vid,s]of kids(type,path,data)){
      if(!s){closeViewer(vid);continue;}
      // Each viewer attempt writes a fresh request id and no offer; anything else is our own write echoing back
      if(s.request&&!s.offer&&viewers[vid]?.reqId!==s.request){
        closeViewer(vid);
        handleViewer(vid,s.request,s.name,s.email).catch(e=>st('Viewer err: '+e.message));
      }
    }
  });
}

async function handleViewer(vid,reqId,name,email){
  const pc=new RTCPeerConnection({iceServers:ICE});
  const label=String(name||'Unknown viewer').slice(0,60)+(email?' ('+String(email).slice(0,100)+')':'');
  // Whitelisted viewers have no valid grant and are never cut off by enforceAccess
  const v={pc,reqId,name:String(name||'Unknown viewer').slice(0,60),label,viaGrant:grantValid(vid),listeners:[]};
  viewers[vid]=v;
  const live=()=>viewers[vid]===v;
  stream.getTracks().forEach(t=>pc.addTrack(t,stream));

  pc.onicecandidate=({candidate})=>{
    if(candidate&&live())dbw('/sessions/'+vid+'/ice_home.json','POST',candidate.toJSON()).catch(()=>{});
  };
  pc.onconnectionstatechange=()=>{
    const s=pc.connectionState;
    if(s==='connected'&&!v.started){v.started=true;logEv('watch-start',vid,v.label);}
    if((s==='failed'||s==='closed')&&live())closeViewer(vid);
    else updateCount();
  };

  const offer=await pc.createOffer();
  await pc.setLocalDescription(offer);
  if(!live())return;
  await dbw('/sessions/'+vid+'/offer.json','PUT',offer.sdp);

  // Viewer candidates can arrive before its answer; hold them until the remote description is set
  const pending=[];
  let answered=false;
  v.listeners.push(sse('/sessions/'+vid+'/answer.json',async(type,path,sdp)=>{
    if(typeof sdp!=='string'||answered||!live())return;
    answered=true;
    try{
      await pc.setRemoteDescription({type:'answer',sdp});
      pending.splice(0).forEach(c=>pc.addIceCandidate(c).catch(()=>{}));
    }catch(e){st('Answer err: '+e.message);}
  }));

  const added=new Set();
  v.listeners.push(sse('/sessions/'+vid+'/ice_viewer.json',(type,path,data)=>{
    for(const[k,c]of kids(type,path,data)){
      if(added.has(k)||!c||!c.candidate)continue;
      added.add(k);
      if(pc.remoteDescription)pc.addIceCandidate(c).catch(()=>{});
      else pending.push(c);
    }
  }));
}

start().catch(e=>st('Fatal: '+e.message));
</script>
</body>
</html>`;
}

export default function HomeModeScreen() {
  useKeepAwake();
  const webRef = useRef(null);
  const { token, error, pushFreshToken } = useSignalingToken(webRef);
  const [status, setStatus] = useState('Loading...');
  const [viewers, setViewers] = useState([]);
  const [cameraReady, setCameraReady] = useState(false);
  const uid = auth.currentUser?.uid;

  // Presence: Firebase drops /heartbeat if this phone loses its connection; re-set it on every reconnect
  useEffect(() => {
    if (!cameraReady) return;
    const hbRef = ref(db, '/heartbeat');
    const unsub = onValue(ref(db, '.info/connected'), async (snap) => {
      if (snap.val() !== true) return;
      try {
        await onDisconnect(hbRef).remove();
        await set(hbRef, { ts: serverTimestamp(), uid });
      } catch (e) {
        setStatus('Heartbeat error: ' + (e?.message ?? String(e)));
      }
    });
    return () => {
      unsub();
      onDisconnect(hbRef).cancel().catch(() => {});
      remove(hbRef).catch(() => {});
      remove(ref(db, '/sessions')).catch(() => {});
    };
  }, [cameraReady]);

  async function stop() {
    setCameraReady(false);
    await AsyncStorage.removeItem('role');
    router.replace('/role-picker');
  }

  function onMessage(e) {
    try {
      const msg = JSON.parse(e.nativeEvent.data);
      if (msg.t === 's') setStatus(msg.m);
      else if (msg.t === 'viewers') setViewers(msg.names);
      else if (msg.t === 'ready') setCameraReady(true);
      else if (msg.t === 'needToken') pushFreshToken();
    } catch {}
  }

  if (!token) {
    return (
      <View style={styles.loading}>
        <StatusBar barStyle="light-content" backgroundColor="#000" />
        <Text style={styles.loadingText}>{error ? 'Auth error: ' + error : status}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#111" />
      <View style={styles.statusRow}>
        <View style={[styles.onlineDot, !cameraReady && styles.offlineDot]} />
        <Text style={styles.statusText}>{status}</Text>
      </View>

      <View style={styles.preview}>
        <WebView
          ref={webRef}
          source={{ html: buildHomeHtml(token, uid), baseUrl: 'https://localhost' }}
          style={styles.webview}
          mediaPlaybackRequiresUserAction={false}
          allowsInlineMediaPlayback={true}
          javaScriptEnabled={true}
          originWhitelist={['*']}
          onPermissionRequest={(request) => { if (request.grant) request.grant(request.resources); }}
          onMessage={onMessage}
        />
      </View>

      <View style={styles.viewersBox}>
        <Text style={styles.viewersTitle}>Watching now ({viewers.length})</Text>
        {viewers.length === 0 ? (
          <Text style={styles.noViewers}>No one is watching</Text>
        ) : (
          viewers.map((name, i) => (
            <View key={i} style={styles.viewerRow}>
              <Text style={styles.viewerIcon}>👁</Text>
              <Text style={styles.viewerName} numberOfLines={1}>{name}</Text>
            </View>
          ))
        )}
      </View>

      <TouchableOpacity style={styles.stopBtn} onPress={stop}>
        <Text style={styles.stopText}>Stop &amp; Switch Role</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#111',
    paddingTop: 52,
    paddingBottom: 40,
    paddingHorizontal: 24,
    gap: 20,
  },
  loading: { flex: 1, backgroundColor: '#111', justifyContent: 'center', alignItems: 'center', padding: 24 },
  loadingText: { color: '#fff', fontSize: 16, textAlign: 'center' },

  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  onlineDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: '#2ecc71' },
  offlineDot: { backgroundColor: '#e67e22' },
  statusText: { flex: 1, color: '#fff', fontSize: 15, fontWeight: '600' },

  preview: {
    width: 150,
    height: 200,
    alignSelf: 'center',
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: '#000',
  },
  webview: { flex: 1, backgroundColor: '#000' },

  viewersBox: {
    flex: 1,
    backgroundColor: '#1c1c1e',
    borderRadius: 14,
    padding: 16,
    gap: 10,
  },
  viewersTitle: { color: '#aaa', fontSize: 13, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  noViewers: { color: '#666', fontSize: 15 },
  viewerRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  viewerIcon: { fontSize: 15 },
  viewerName: { flex: 1, color: '#fff', fontSize: 16 },

  stopBtn: {
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: 'rgba(192,57,43,0.85)',
    alignItems: 'center',
  },
  stopText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
