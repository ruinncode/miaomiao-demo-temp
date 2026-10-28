// MMNet: two-player pairing over PeerJS (WebRTC) for one room. No server of our own.
// Room: the secret comes from the page URL, e.g. https://…/index.html#room=k3v9x2…  (makeRoom() creates one).
// Both browsers run the same code. Whoever claims the room's "home" peer id first is the host; the other is the guest.
// API (all that Godot needs):  MMNet.start(who, onState, onMsg)  MMNet.send(str)  MMNet.close()  MMNet.rtt()
//   plus room() link() makeRoom() deviceId() pathType() role() connected()
//   who     : stable id of this player/tab ('' = per-tab id from sessionStorage). A reload with the same id
//             replaces the old connection; a different id while the pair is healthy gets 'busy'.
//   onState : (state, detail) with state in
//             'connecting' | 'waiting' (host, nobody yet) | 'connected' (detail 'host'|'guest') |
//             'away' (the other side left, retrying) | 'busy' (a third tab tried) | 'signal-trouble' |
//             'no-room' (no #room= in the URL and no baked secret) | 'error'
//   onMsg   : (string)
// Config: window.MM_NET_CFG (public, may be in the head include) and window.MM_NET_PRIVATE from
// net_private.js (NOT committed; TURN servers). See net_private.example.js.
(function () {
  const PRIV = window.MM_NET_PRIVATE || {};
  const CFG = Object.assign({
    secret: '',                         // optional baked-in fallback room; the URL #room= wins
    iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }, { urls: 'stun:stun.l.google.com:19302' }],
    peerOpts: {},                       // tests may pass host/port/path/secure for a local PeerJS server
  }, window.MM_NET_CFG || {});
  const ROOM_RE = /^[A-Za-z0-9_]{6,64}$/;
  const hashRoom = () => { const m = /(?:^|[#&])room=([^&]*)/.exec(location.hash || ''); return m ? decodeURIComponent(m[1]) : ''; };
  const pickRoom = () => { const h = hashRoom(); if (ROOM_RE.test(h)) return h; return ROOM_RE.test(CFG.secret || '') ? CFG.secret : ''; };
  let SECRET = pickRoom();
  let HOME = 'mmcx-' + SECRET + '-home';
  let iceServers = CFG.iceServers.concat(PRIV.iceServers || []);
  let pathType = '';
  const devId = (() => { try { let v = sessionStorage.getItem('mm_dev'); if (!v) { v = 'd' + Math.random().toString(36).slice(2, 12); sessionStorage.setItem('mm_dev', v); } return v; } catch (e) { return 'd' + Math.random().toString(36).slice(2, 12); } })();
  const STALE_MS = 6000;
  let peer = null, conn = null, role = null, who = null, onState = () => {}, onMsg = () => {}, closed = false;
  let lastRecv = 0, rtt = 0, hb = null, retry = null, everConnected = false, gen = 0;

  const state = (s, d) => { try { onState(s, d || ''); } catch (e) { console.error(e); } };
  const later = (fn, ms) => { clearTimeout(retry); retry = setTimeout(fn, ms); };
  const kill = () => { try { conn && conn.close(); } catch (e) {} try { peer && peer.destroy(); } catch (e) {} conn = null; peer = null; };
  const newPeer = (id) => new Peer(id, Object.assign({ debug: 1, config: { iceServers } }, CFG.peerOpts));

  // Try to become host. If the home id is taken, become the guest of whoever holds it.
  function boot() {
    if (closed) return;
    const my = ++gen; kill(); role = null; state(everConnected ? 'away' : 'connecting');
    const p = peer = newPeer(HOME);
    p.on('open', () => { if (my !== gen) return; role = 'host'; state('waiting'); });
    p.on('connection', (c) => { if (my === gen) accept(c); });
    p.on('disconnected', () => { if (my === gen && !closed && !p.destroyed) setTimeout(() => { try { p.reconnect(); } catch (e) {} }, 1000); });
    p.on('error', (err) => {
      if (my !== gen) return;
      if (err.type === 'unavailable-id') { joinHome(my); return; }
      signalOrError(err, () => boot());
    });
  }

  function joinHome(my) {
    if (closed || my !== gen) return;
    try { peer && peer.destroy(); } catch (e) {}
    const p = peer = newPeer();
    p.on('open', () => {
      if (my !== gen) return; role = 'guest';
      const c = p.connect(HOME, { reliable: true, serialization: 'json' });
      attach(c, my);
      later(() => { if (my === gen && !(conn && conn.open)) boot(); }, 8000); // never opened: start over
    });
    p.on('error', (err) => {
      if (my !== gen) return;
      if (err.type === 'peer-unavailable') { later(() => boot(), 1500); return; } // host just left: try to claim home
      signalOrError(err, () => boot());
    });
  }

  function signalOrError(err, again) {
    const t = err.type || String(err);
    if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(t)) { state('signal-trouble', t); later(again, 3000); }
    else { state('error', t); later(again, 5000); }
  }

  // host side: take the newcomer unless a *different* player is already connected and healthy
  function accept(c) {
    c.on('data', function first(m) {
      if (!m || m.t !== 'hello') return;
      const healthy = conn && conn.open && performance.now() - lastRecv < STALE_MS;
      if (healthy && conn.peerWho !== m.who) { try { c.send({ t: 'busy' }); } catch (e) {} setTimeout(() => { try { c.close(); } catch (e) {} }, 300); return; }
      if (conn) { const old = conn; conn = null; try { old.close(); } catch (e) {} }
      c.peerWho = m.who; attach(c, gen, true);
      c.off && c.off('data', first);
    });
  }

  function attach(c, my, alreadyOpen) {
    conn = c;
    const opened = () => {
      if (my !== gen || conn !== c) return;
      everConnected = true; lastRecv = performance.now();
      try { c.send({ t: 'hello', who }); } catch (e) {}
      state('connected', role); samplePath(c);
    };
    if (alreadyOpen || c.open) opened(); else c.on('open', opened);
    c.on('data', (m) => {
      if (my !== gen || conn !== c || !m) return;
      lastRecv = performance.now();
      if (m.t === 'ping') { try { c.send({ t: 'pong', s: m.s }); } catch (e) {} }
      else if (m.t === 'pong') rtt = performance.now() - m.s;
      else if (m.t === 'busy') { state('busy'); closed = true; clearInterval(hb); kill(); }
      else if (m.t === 'm') { try { onMsg(m.d); } catch (e) { console.error(e); } }
    });
    const lost = () => {
      if (closed || my !== gen || conn !== c) return;
      conn = null; state('away');
      if (role === 'guest') later(() => boot(), 1500);   // guest re-runs boot: claims home if the host is gone
      else state('waiting');                              // host just waits on the same home id
    };
    c.on('close', lost); c.on('error', lost);
  }

  // which network path WebRTC chose: 'host' (same network), 'srflx' (STUN), 'relay' (TURN)
  function samplePath(c) {
    pathType = '';
    const pc = c && c.peerConnection; if (!pc || !pc.getStats) return;
    setTimeout(() => pc.getStats().then((st) => {
      let pair = null; st.forEach((r) => { if (r.type === 'candidate-pair' && r.state === 'succeeded' && (r.nominated || r.selected)) pair = r; });
      if (pair) st.forEach((r) => { if (r.id === pair.localCandidateId) pathType = r.candidateType || ''; });
    }).catch(() => {}), 1500);
  }

  // TURN credentials fetched at start (e.g. a Metered credentials URL in net_private.js)
  function loadTurn() {
    if (!PRIV.turnCredentialsUrl) return Promise.resolve();
    const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 4000);
    return fetch(PRIV.turnCredentialsUrl, { signal: ctl.signal }).then((r) => r.json()).then((list) => {
      if (Array.isArray(list)) iceServers = CFG.iceServers.concat(PRIV.iceServers || [], list);
    }).catch((e) => console.warn('MMNet: TURN credentials not loaded', e && e.name)).finally(() => clearTimeout(to));
  }

  function heartbeat() {
    clearInterval(hb);
    hb = setInterval(() => {
      if (!conn || !conn.open) return;
      try { conn.send({ t: 'ping', s: performance.now() }); } catch (e) {}
      if (performance.now() - lastRecv > STALE_MS) { const c = conn; try { c.close(); } catch (e) {} c.emit && c.emit('close'); }
    }, 1000);
  }

  // phones freeze background tabs: when the page is visible again and the link is gone, start over
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !closed && who !== null && !(conn && conn.open) && SECRET) later(() => boot(), 300);
  });

  window.MMNet = {
    start(w, st, msg) {
      who = w || devId; onState = st || onState; onMsg = msg || onMsg; closed = false; everConnected = false;
      SECRET = pickRoom(); HOME = 'mmcx-' + SECRET + '-home';
      if (!SECRET) { state('no-room'); return; }
      heartbeat(); state('connecting'); loadTurn().then(() => { if (!closed) boot(); });
    },
    send(str) { if (conn && conn.open) { try { conn.send({ t: 'm', d: String(str) }); return true; } catch (e) {} } return false; },
    close() { closed = true; clearInterval(hb); clearTimeout(retry); gen++; kill(); },
    rtt() { return Math.round(rtt); },
    role() { return role; },
    connected() { return !!(conn && conn.open); },
    room() { return pickRoom(); },
    link() { const r = pickRoom(); return r ? location.href.split('#')[0] + '#room=' + r : ''; },
    makeRoom() {
      const a = new Uint8Array(12); crypto.getRandomValues(a);
      const r = Array.from(a, (b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');
      location.hash = 'room=' + r; return this.link();
    },
    deviceId() { return devId; },
    pathType() { return pathType; },
    turnConfigured() { return !!(PRIV.turnCredentialsUrl || (PRIV.iceServers || []).length); },
  };
})();
