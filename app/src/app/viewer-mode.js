import { useEffect, useRef, useState } from 'react';
import { View, Text, Image, StyleSheet, TouchableOpacity, ActivityIndicator, AppState, Platform } from 'react-native';
import { WebView } from 'react-native-webview';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { router } from 'expo-router';
import { ref, onValue, remove } from 'firebase/database';
import { auth, db } from '../config';
import { signalingScript, useSignalingToken } from '../webview-signaling';
import { confirmWithDevice } from '../access';

const DEVICE_NAME = `Android app (${Platform.constants?.Model ?? 'phone'})`.slice(0, 59);

function buildViewerHtml(idToken, myUid, myName, myEmail, myDevice) {
  return `<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#000;overflow:hidden;font-family:sans-serif}
video{position:absolute;top:50%;left:50%;object-fit:contain}
#st{position:fixed;top:40%;left:0;right:0;text-align:center;color:#fff;font-size:16px;padding:12px}
#rot{position:fixed;left:20px;top:48px;font-size:15px;font-weight:600;color:#fff;background:rgba(0,0,0,.6);border:0;border-radius:20px;padding:8px 16px}
</style>
</head>
<body>
<video id="v" autoplay playsinline></video>
<div id="st">Connecting...</div>
<button id="rot">⟳ Rotate</button>
<script>
${signalingScript(idToken, myUid)}
let rotation=0;
try{rotation=Number(localStorage.getItem('pettv-rotation'))||0;}catch(_){}

// Sideways turns swap the box so the rotated video still fills the screen
function applyRotation(){
  const v=document.getElementById('v');
  const sideways=rotation%180!==0;
  v.style.width=(sideways?innerHeight:innerWidth)+'px';
  v.style.height=(sideways?innerWidth:innerHeight)+'px';
  v.style.transform='translate(-50%,-50%) rotate('+rotation+'deg)';
}
document.getElementById('rot').onclick=()=>{
  rotation=(rotation+90)%360;
  try{localStorage.setItem('pettv-rotation',String(rotation));}catch(_){}
  applyRotation();
};
addEventListener('resize',applyRotation);
applyRotation();
const REQ=Date.now()+'-'+Math.random().toString(36).slice(2,8);
const NAME=${JSON.stringify(myName).replace(/</g, '\\u003c')};
const EMAIL=${JSON.stringify(myEmail).replace(/</g, '\\u003c')};
const DEVICE=${JSON.stringify(myDevice).replace(/</g, '\\u003c')};
let pc=null;
let superseded=false;

function lost(msg){if(!superseded){st(msg);post({t:'lost',m:msg});}}

async function connect(){
  st('Requesting stream...');
  await dbw('/sessions/'+UID+'.json','PUT',{request:REQ,name:NAME,email:EMAIL,device:DEVICE});
  st('Waiting for home phone...');
  // Another device of the same account replaced our request; stop instead of hanging on "Reconnecting"
  const reqListener=sse('/sessions/'+UID+'/request.json',(type,path,req)=>{
    if(typeof req!=='string'||req===REQ||superseded)return;
    superseded=true;
    reqListener.close();
    if(pc)pc.close();
    post({t:'superseded'});
  });
  const offerListener=sse('/sessions/'+UID+'/offer.json',(type,path,sdp)=>{
    if(typeof sdp!=='string'||pc)return;
    offerListener.close();
    startPc(sdp).catch(e=>lost('Error: '+e.message));
  });
}

async function startPc(offerSdp){
  st('Creating connection...');
  pc=new RTCPeerConnection({iceServers:ICE});

  pc.ontrack=e=>{
    if(e.streams&&e.streams[0])document.getElementById('v').srcObject=e.streams[0];
  };
  pc.onconnectionstatechange=()=>{
    const s=pc.connectionState;
    if(s==='connected'){document.getElementById('st').style.display='none';post({t:'connected'});}
    else if(s==='disconnected'){document.getElementById('st').style.display='';st('Reconnecting...');}
    else if(s==='failed')lost('Connection lost');
  };
  pc.onicecandidate=({candidate})=>{
    if(candidate)dbw('/sessions/'+UID+'/ice_viewer.json','POST',candidate.toJSON()).catch(()=>{});
  };

  await pc.setRemoteDescription({type:'offer',sdp:offerSdp});
  const answer=await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await dbw('/sessions/'+UID+'/answer.json','PUT',answer.sdp);
  st('Waiting for stream...');

  const added=new Set();
  sse('/sessions/'+UID+'/ice_home.json',(type,path,data)=>{
    for(const[k,c]of kids(type,path,data)){
      if(added.has(k)||!c||!c.candidate)continue;
      added.add(k);
      pc.addIceCandidate(c).catch(()=>{});
    }
  });
}

connect().catch(e=>lost('Error: '+e.message));
</script>
</body>
</html>`;
}

export default function ViewerModeScreen() {
  const webRef = useRef(null);
  const { token, error, pushFreshToken } = useSignalingToken(webRef);
  const [phase, setPhase] = useState('idle'); // idle | connecting | connected | error
  const [attempt, setAttempt] = useState(0);
  const [homeOnline, setHomeOnline] = useState(null);
  const [statusMsg, setStatusMsg] = useState('');
  const [locked, setLockedState] = useState(true);
  const [unlockError, setUnlockError] = useState(null);
  const lockedRef = useRef(true);
  const promptingRef = useRef(false);
  const myUid = auth.currentUser?.uid;

  function setLocked(value) {
    lockedRef.current = value;
    setLockedState(value);
  }

  async function unlock() {
    promptingRef.current = true;
    setUnlockError(null);
    let ok = false;
    try {
      ok = await confirmWithDevice('Unlock PetTV');
    } catch (e) {
      if (e.code === 'no-lock') ok = true; // nothing to check against on a phone without a screen lock
      else setUnlockError(e.message);
    }
    promptingRef.current = false;
    if (ok) setLocked(false);
  }

  // Lock whenever the app leaves the foreground so a picked-up phone can't open the stream
  useEffect(() => {
    unlock();
    const sub = AppState.addEventListener('change', (state) => {
      if (promptingRef.current) return; // the system lock prompt itself backgrounds the app on some phones
      if (state === 'background') {
        setLocked(true);
        setPhase('idle');
        endSession();
      } else if (state === 'active' && lockedRef.current) {
        unlock();
      }
    });
    return () => sub.remove();
  }, []);

  // Once another device took over, the session belongs to it and must not be deleted from here
  const supersededRef = useRef(false);
  function endSession() {
    if (supersededRef.current) return Promise.resolve();
    return remove(ref(db, `/sessions/${myUid}`)).catch(() => {});
  }

  useEffect(() => {
    // Permission denied here means access expired or was revoked; send them back to enter a new code
    const hbUnsub = onValue(ref(db, '/heartbeat'), (snap) => setHomeOnline(snap.exists()), async () => {
      await AsyncStorage.removeItem('role');
      router.replace('/role-picker');
    });
    return () => {
      hbUnsub();
      endSession();
    };
  }, []);

  async function watch() {
    setStatusMsg('');
    supersededRef.current = false;
    await endSession();
    setAttempt(a => a + 1);
    setPhase('connecting');
  }

  function disconnect() {
    setPhase('idle');
    setStatusMsg('');
    endSession();
  }

  async function switchRole() {
    await endSession();
    await AsyncStorage.removeItem('role');
    router.replace('/role-picker');
  }

  function onMessage(e) {
    try {
      const msg = JSON.parse(e.nativeEvent.data);
      if (msg.t === 's') setStatusMsg(msg.m);
      else if (msg.t === 'connected') setPhase('connected');
      else if (msg.t === 'lost') { setPhase('error'); setStatusMsg(msg.m); endSession(); }
      else if (msg.t === 'superseded') { supersededRef.current = true; setPhase('superseded'); }
      else if (msg.t === 'needToken') pushFreshToken();
    } catch {}
  }

  if (locked) {
    return (
      <View style={styles.container}>
        <Text style={styles.emoji}>🔒</Text>
        <Text style={styles.title}>PetTV</Text>
        {!!unlockError && <Text style={styles.errorDetail}>{unlockError}</Text>}
        <TouchableOpacity style={styles.connectBtn} onPress={unlock}>
          <Text style={styles.connectText}>Unlock</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.switchBtn} onPress={switchRole}>
          <Text style={styles.switchText}>Switch role</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if ((phase === 'connecting' || phase === 'connected') && token) {
    return (
      <View style={styles.fullscreen}>
        <WebView
          key={attempt}
          ref={webRef}
          source={{ html: buildViewerHtml(token, myUid, auth.currentUser?.displayName || auth.currentUser?.email || 'Android viewer', auth.currentUser?.email ?? '', DEVICE_NAME), baseUrl: 'https://localhost' }}
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
      <Image source={require('../../assets/images/tako.jpg')} style={styles.hero} />
      <Text style={styles.title}>PetTV</Text>

      {!!error && <Text style={styles.errorDetail}>Auth error: {error}</Text>}

      {(homeOnline === null || !token) && !error && <ActivityIndicator color="#4A90E2" />}

      {homeOnline === false && phase !== 'error' && (
        <Text style={styles.offlineText}>Home phone is offline</Text>
      )}

      {homeOnline === true && token && phase === 'idle' && (
        <TouchableOpacity style={styles.connectBtn} onPress={watch}>
          <Text style={styles.connectText}>▶  Watch Live</Text>
        </TouchableOpacity>
      )}

      {phase === 'superseded' && (
        <>
          <Text style={styles.statusText}>Now watching on another device</Text>
          <TouchableOpacity style={styles.connectBtn} onPress={watch}>
            <Text style={styles.connectText}>Watch here</Text>
          </TouchableOpacity>
        </>
      )}

      {phase === 'error' && (
        <>
          <Text style={styles.errorText}>Connection failed</Text>
          {!!statusMsg && <Text style={styles.errorDetail}>{statusMsg}</Text>}
          {homeOnline && (
            <TouchableOpacity style={styles.connectBtn} onPress={watch}>
              <Text style={styles.connectText}>Retry</Text>
            </TouchableOpacity>
          )}
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
  hero: { width: 180, height: 240, borderRadius: 24 },
  title: { fontSize: 32, fontWeight: '700', color: '#1a1a1a' },
  offlineText: { fontSize: 15, color: '#888' },
  statusText: { fontSize: 15, color: '#555', textAlign: 'center' },
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
