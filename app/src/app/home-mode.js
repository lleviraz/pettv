import { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, StatusBar, Pressable, BackHandler, Alert, AppState } from 'react-native';
import { WebView } from 'react-native-webview';
import { useKeepAwake } from 'expo-keep-awake';
import * as Brightness from 'expo-brightness';
import { confirmWithDevice, logEvent } from '../access';
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
const CAMERA_IDLE_MS=30000;
let stream=null;
let streamPromise=null;
let releaseTimer=null;

function grantValid(vid){
  const g=grants[vid];
  return !!g&&g.redeemedAt+g.accessMs>Date.now();
}

function logEv(event,subject,detail){
  dbw('/log.json','POST',{uid:UID,event,subject,detail,ts:{'.sv':'timestamp'}}).catch(()=>{});
}

// Camera and mic run only while someone watches, so the green privacy dot means "being watched"
function ensureStream(who){
  clearTimeout(releaseTimer);
  if(stream)return Promise.resolve(stream);
  if(!streamPromise){
    streamPromise=navigator.mediaDevices.getUserMedia({
      audio:true,
      video:{facingMode:'user',width:{ideal:640},height:{ideal:480},frameRate:{ideal:15}}
    }).then(s=>{
      stream=s;
      document.getElementById('v').srcObject=s;
      post({t:'camera',on:true});
      logEv('camera-on',undefined,who);
      return s;
    }).finally(()=>{streamPromise=null;});
  }
  return streamPromise;
}

// Kept alive briefly after the last viewer so a quick reconnect doesn't wait for the camera again
function releaseIfIdle(){
  clearTimeout(releaseTimer);
  if(Object.keys(viewers).length>0||!stream)return;
  releaseTimer=setTimeout(()=>{
    if(Object.keys(viewers).length>0||!stream)return;
    stream.getTracks().forEach(t=>t.stop());
    stream=null;
    document.getElementById('v').srcObject=null;
    post({t:'camera',on:false});
    logEv('camera-off',undefined,'no viewers for 30s');
  },CAMERA_IDLE_MS);
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
  releaseIfIdle();
}

async function start(){
  try{await dbw('/sessions.json','DELETE');}catch(e){st(e.message);return;}
  st('Online');
  post({t:'ready'});
  logEv('home-online',undefined,'Home phone started');

  sse('/grants.json',(type,path,data)=>mirror(grants,type,path,data));
  sse('/blocked.json',(type,path,data)=>mirror(blocked,type,path,data));
  setInterval(enforceAccess,15000);

  sse('/sessions.json',(type,path,data)=>{
    for(const[vid,s]of kids(type,path,data)){
      if(!s){closeViewer(vid);continue;}
      // Each viewer attempt writes a fresh request id and no offer; anything else is our own write echoing back
      if(s.request&&!s.offer&&viewers[vid]?.reqId!==s.request){
        closeViewer(vid);
        handleViewer(vid,s.request,s.name,s.email,s.device).catch(e=>st('Viewer err: '+e.message));
      }
    }
  });
}

async function handleViewer(vid,reqId,name,email,device){
  const pc=new RTCPeerConnection({iceServers:ICE});
  const shortName=String(name||'Unknown viewer').slice(0,60);
  const dev=device?' · '+String(device).slice(0,59):'';
  const label=(shortName+(email?' ('+String(email).slice(0,80)+')':'')+dev).slice(0,199);
  // Whitelisted viewers have no valid grant and are never cut off by enforceAccess
  const v={pc,reqId,name:shortName+dev,label,viaGrant:grantValid(vid),listeners:[]};
  viewers[vid]=v;
  const live=()=>viewers[vid]===v;
  let s;
  try{
    s=await ensureStream(label);
  }catch(e){
    st('Camera error: '+e.message);
    closeViewer(vid);
    return;
  }
  // The viewer may have left while the camera was starting; closeViewer saw no stream yet to release
  if(!live()){releaseIfIdle();return;}
  s.getTracks().forEach(t=>pc.addTrack(t,s));

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
  const [online, setOnline] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [dark, setDark] = useState(false);
  const [peek, setPeek] = useState(false);
  const promptingRef = useRef(false);
  const uid = auth.currentUser?.uid;

  // Presence: Firebase drops /heartbeat if this phone loses its connection; re-set it on every reconnect
  useEffect(() => {
    if (!online) return;
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
  }, [online]);

  // Dark mode keeps the camera streaming under a black overlay; on AMOLED black pixels are off
  useEffect(() => {
    const dimmed = dark && !peek;
    (dimmed ? Brightness.setBrightnessAsync(0) : Brightness.restoreSystemBrightnessAsync()).catch(() => {});
  }, [dark, peek]);

  useEffect(() => () => { Brightness.restoreSystemBrightnessAsync().catch(() => {}); }, []);

  useEffect(() => {
    if (!peek) return;
    const t = setTimeout(() => setPeek(false), 5000);
    return () => clearTimeout(t);
  }, [peek]);

  // Android blocks the camera once the screen is off, so stop advertising "online" until it's back
  useEffect(() => {
    if (!online) return;
    const hbRef = ref(db, '/heartbeat');
    const sub = AppState.addEventListener('change', (state) => {
      if (promptingRef.current) return; // the stop() device prompt can briefly background the app
      if (state === 'background') {
        remove(hbRef).catch(() => {});
        logEvent('home-paused', { detail: 'Screen off or app left; camera unavailable' });
      } else if (state === 'active') {
        set(hbRef, { ts: serverTimestamp(), uid }).catch(() => {});
        logEvent('home-resumed', { detail: 'Back in the foreground' });
      }
    });
    return () => sub.remove();
  }, [online]);

  // Back would close the app and stop the camera without the device check in stop()
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => sub.remove();
  }, []);

  async function stop() {
    promptingRef.current = true;
    try {
      if (!(await confirmWithDevice('Stop streaming'))) return;
    } catch (e) {
      if (e.code !== 'no-lock') {
        Alert.alert('Could not verify', e.message);
        return;
      }
      Alert.alert('No screen lock', `${e.message}, so anyone can stop the camera.`);
    } finally {
      promptingRef.current = false;
    }
    setDark(false);
    setOnline(false);
    logEvent('home-stopped', { detail: 'Stopped from the home phone' });
    await AsyncStorage.removeItem('role');
    router.replace('/role-picker');
  }

  function onMessage(e) {
    try {
      const msg = JSON.parse(e.nativeEvent.data);
      if (msg.t === 's') setStatus(msg.m);
      else if (msg.t === 'viewers') setViewers(msg.names);
      else if (msg.t === 'ready') setOnline(true);
      else if (msg.t === 'camera') setCameraOn(msg.on);
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
    <View style={styles.screen}>
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#111" hidden={dark && !peek} />
      <View style={styles.statusRow}>
        <View style={[styles.onlineDot, !online && styles.offlineDot]} />
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
        {!cameraOn && (
          <View style={styles.cameraOff} pointerEvents="none">
            <Text style={styles.cameraOffIcon}>📷</Text>
            <Text style={styles.cameraOffText}>Camera off{'\n'}turns on when someone watches</Text>
          </View>
        )}
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

      <TouchableOpacity style={styles.darkBtn} onPress={() => { setPeek(false); setDark(true); }}>
        <Text style={styles.darkText}>🌙 Dark mode</Text>
      </TouchableOpacity>
      <TouchableOpacity style={styles.stopBtn} onPress={stop}>
        <Text style={styles.stopText}>Stop &amp; Switch Role</Text>
      </TouchableOpacity>
    </View>

      {dark && (
        <Pressable style={styles.darkOverlay} onPress={() => setPeek(true)}>
          {peek && (
            <View style={styles.peekPanel}>
              <Text style={styles.peekStatus}>{status} · streaming</Text>
              <TouchableOpacity style={styles.darkBtn} onPress={() => { setDark(false); setPeek(false); }}>
                <Text style={styles.darkText}>Exit dark mode</Text>
              </TouchableOpacity>
            </View>
          )}
        </Pressable>
      )}
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
  cameraOff: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#000',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
    padding: 12,
  },
  cameraOffIcon: { fontSize: 28, opacity: 0.6 },
  cameraOffText: { color: '#888', fontSize: 13, textAlign: 'center' },

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
  darkBtn: { paddingVertical: 14, paddingHorizontal: 24, borderRadius: 12, backgroundColor: '#2c2c2e', alignItems: 'center' },
  darkText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  screen: { flex: 1, backgroundColor: '#111' },
  darkOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#000',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  peekPanel: { alignItems: 'center', gap: 16 },
  peekStatus: { color: '#888', fontSize: 15 },
});
