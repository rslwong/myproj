'use strict';

// ── Helpers ────────────────────────────────────────────────────────────────

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function $(id) { return document.getElementById(id); }

function toast(msg, duration = 2500) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), duration);
}

function showError(msg) {
  const el = $('join-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function clearError() { $('join-error').classList.add('hidden'); }

// ── ICE servers (public STUN) ───────────────────────────────────────────────

const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

// ── App ────────────────────────────────────────────────────────────────────

class PhoneConf {
  constructor() {
    this.peerId    = uid();
    this.roomId    = null;
    this.ws        = null;
    this.localStream = null;
    this.audioCtx  = null;

    // peerId → RTCPeerConnection
    this.peers = new Map();
    // peerId → HTMLAudioElement
    this.audioEls = new Map();
    // peerId → AnalyserNode  (for VAD)
    this.analysers = new Map();
    // peerId → MediaStreamAudioSourceNode
    this.audioSourceNodes = new Map();

    this.myName     = '';
    this._chatOpen  = false;
    this._unreadCnt = 0;
    this.isMuted   = false;
    this.isSilent  = false;

    this._timerInterval = null;
    this._timerStart    = null;
    this._vadLoop       = null;

    this._boundHandleKeyboard = this._handleKeyboard.bind(this);

    this._bindUI();
  }

  // ── UI wiring ──────────────────────────────────────────────────────────

  _bindUI() {
    $('create-btn').addEventListener('click', () => this._createRoom());
    $('join-btn').addEventListener('click',   () => this._joinRoom());
    $('room-code-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._joinRoom();
    });
    $('room-code-input').addEventListener('input', (e) => {
      e.target.value = e.target.value.replace(/\D/g, '').slice(0, 3);
      clearError();
    });

    $('mute-btn').addEventListener('click',    () => this._toggleMute());
    $('speaker-btn').addEventListener('click', () => this._toggleSilent());
    $('leave-btn').addEventListener('click',   () => this._leaveRoom());
    $('copy-btn').addEventListener('click',    () => this._copyRoomCode());
    $('chat-btn').addEventListener('click',       () => this._toggleChat());
    $('chat-close-btn').addEventListener('click', () => this._toggleChat());
    $('chat-send-btn').addEventListener('click',  () => this._sendChat());
    $('chat-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._sendChat();
    });
  }

  // ── WebSocket connection ───────────────────────────────────────────────

  _connect() {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      this.ws = new WebSocket(`${proto}//${location.host}`);
      this.ws.addEventListener('open',    resolve);
      this.ws.addEventListener('error',   reject);
      this.ws.addEventListener('message', (e) => this._onSignal(JSON.parse(e.data)));
      this.ws.addEventListener('close',   () => this._onWsClose());
    });
  }

  _send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  // ── Signaling handler ──────────────────────────────────────────────────

  async _onSignal(msg) {
    switch (msg.type) {
      case 'room-created':
        this.roomId = msg.roomId;
        await this._startLocalStream();
        this._showCallScreen();
        break;

      case 'room-joined':
        this.roomId = msg.roomId;
        await this._startLocalStream();
        this._showCallScreen();
        for (const { peerId, name } of msg.peers) {
          await this._connectToPeer(peerId, true, name);
        }
        break;

      case 'peer-joined':
        await this._connectToPeer(msg.peerId, false, msg.name);
        break;

      case 'offer':
        await this._handleOffer(msg.fromPeerId, msg.sdp);
        break;

      case 'answer':
        await this._handleAnswer(msg.fromPeerId, msg.sdp);
        break;

      case 'ice-candidate':
        await this._handleIce(msg.fromPeerId, msg.candidate);
        break;

      case 'peer-left':
        this._removePeer(msg.peerId);
        toast('A participant left the call.');
        break;

      case 'chat':
        this._addChatMessage(msg.name, msg.text, false);
        break;

      case 'error':
        showError(msg.message);
        this.ws.close();
        this.ws = null;
        break;
    }
  }

  // ── Media ──────────────────────────────────────────────────────────────

  async _startLocalStream() {
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl:  true,
        },
        video: false,
      });
      this._setupLocalVAD();
    } catch (err) {
      alert('Microphone access denied. Please allow microphone and reload.');
      throw err;
    }
  }

  _setupLocalVAD() {
    if (!this.audioCtx) this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    this.audioCtx.resume().catch(() => {});
    const src = this.audioCtx.createMediaStreamSource(this.localStream);
    const analyser = this.audioCtx.createAnalyser();
    analyser.fftSize = 256;
    src.connect(analyser);
    this.analysers.set('local', analyser);
  }

  // ── Peer connections ───────────────────────────────────────────────────

  _makePeerConnection(remotePeerId) {
    const pc = new RTCPeerConnection(ICE_CONFIG);
    this.peers.set(remotePeerId, pc);

    // Add local audio tracks
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => pc.addTrack(track, this.localStream));
    }

    pc.addEventListener('track', (e) => {
      this._playRemoteAudio(remotePeerId, e.streams[0]);
    });

    pc.addEventListener('icecandidate', (e) => {
      if (e.candidate) {
        this._send({ type: 'ice-candidate', targetPeerId: remotePeerId, candidate: e.candidate });
      }
    });

    pc.addEventListener('connectionstatechange', () => {
      this._updatePeerStatus(remotePeerId, pc.connectionState);
    });

    return pc;
  }

  async _connectToPeer(remotePeerId, weOffer, name = null) {
    this._addParticipantCard(remotePeerId, false, name);
    const pc = this._makePeerConnection(remotePeerId);

    if (weOffer) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this._send({ type: 'offer', targetPeerId: remotePeerId, sdp: pc.localDescription });
    }
  }

  async _handleOffer(fromPeerId, sdp) {
    if (!this.peers.has(fromPeerId)) {
      this._addParticipantCard(fromPeerId);
      this._makePeerConnection(fromPeerId);
    }
    const pc = this.peers.get(fromPeerId);
    await pc.setRemoteDescription(sdp);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    this._send({ type: 'answer', targetPeerId: fromPeerId, sdp: pc.localDescription });
  }

  async _handleAnswer(fromPeerId, sdp) {
    const pc = this.peers.get(fromPeerId);
    if (pc) await pc.setRemoteDescription(sdp);
  }

  async _handleIce(fromPeerId, candidate) {
    const pc = this.peers.get(fromPeerId);
    if (pc && candidate) {
      try { await pc.addIceCandidate(candidate); } catch {}
    }
  }

  // ── Audio playback ─────────────────────────────────────────────────────

  _playRemoteAudio(peerId, stream) {
    let audio = this.audioEls.get(peerId);
    if (!audio) {
      audio = new Audio();
      audio.autoplay = true;
      document.body.appendChild(audio);
      this.audioEls.set(peerId, audio);
    }
    audio.srcObject = stream;

    if (!this.audioCtx) this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = this.audioCtx.createMediaStreamSource(stream);
    const analyser = this.audioCtx.createAnalyser();
    analyser.fftSize = 256;
    src.connect(analyser);
    this.analysers.set(peerId, analyser);
    this.audioSourceNodes.set(peerId, src);

    // Route to speaker or earpiece based on current mode
    this._applyAudioRouting(audio, src);
  }

  _applyAudioRouting(audio, src) {
    audio.muted = true; // always route through AudioContext, never the audio element
    if (this.isSilent) {
      try { src.disconnect(this.audioCtx.destination); } catch {}
    } else {
      // resume() is idempotent — safe to call repeatedly; required on iOS
      // because the context can be suspended between the tap and audio arriving
      this.audioCtx.resume().catch(() => {});
      try { src.connect(this.audioCtx.destination); } catch {}
    }
  }

  // ── Controls ───────────────────────────────────────────────────────────

  _toggleMute() {
    this.isMuted = !this.isMuted;
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach(t => { t.enabled = !this.isMuted; });
    }
    const btn = $('mute-btn');
    if (this.isMuted) {
      btn.classList.add('muted');
      btn.querySelector('.ctrl-label').textContent = 'Unmute';
      btn.querySelector('.ctrl-ico').innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
          <path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8"/>
          <line x1="3" y1="3" x2="21" y2="21" stroke="currentColor" stroke-width="2"/>
        </svg>`;
      // Mark local card as muted
      const card = document.getElementById('peer-local');
      if (card) card.querySelector('.peer-status').textContent = 'Muted';
    } else {
      btn.classList.remove('muted');
      btn.querySelector('.ctrl-label').textContent = 'Mute';
      btn.querySelector('.ctrl-ico').innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
          <path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8"/>
        </svg>`;
      const card = document.getElementById('peer-local');
      if (card) { const s = card.querySelector('.peer-status'); s.textContent = 'Speaking'; s.className = 'peer-status ok'; }
    }
  }

  _toggleSilent() {
    this.isSilent = !this.isSilent;

    const btn   = $('speaker-btn');
    const label = $('speaker-label');
    const ico   = $('speaker-ico');

    if (this.isSilent) {
      btn.classList.add('muted');
      label.textContent = 'Silent';
      ico.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
          <line x1="23" y1="9" x2="17" y2="15"/>
          <line x1="17" y1="9" x2="23" y2="15"/>
        </svg>`;
    } else {
      btn.classList.remove('muted');
      label.textContent = 'Sound';
      ico.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
          <path d="M15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14"/>
        </svg>`;
    }

    this.audioEls.forEach((audio, peerId) => {
      const src = this.audioSourceNodes.get(peerId);
      if (src) this._applyAudioRouting(audio, src);
    });
    toast(this.isSilent ? 'Sound off' : 'Sound on');
  }

  _leaveRoom() {
    clearInterval(this._timerInterval);
    cancelAnimationFrame(this._vadLoop);

    // Close all peer connections
    this.peers.forEach(pc => pc.close());
    this.peers.clear();

    // Stop all audio
    this.audioEls.forEach(audio => {
      audio.srcObject = null;
      audio.remove();
    });
    this.audioEls.clear();
    this.analysers.clear();
    this.audioSourceNodes.clear();

    // Stop microphone
    if (this.localStream) {
      this.localStream.getTracks().forEach(t => t.stop());
      this.localStream = null;
    }

    if (this.audioCtx) {
      this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
    }

    window.visualViewport?.removeEventListener('resize', this._boundHandleKeyboard);
    $('call-screen').style.transform = '';

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.isMuted  = false;
    this.isSilent = false;
    this.roomId   = null;
    this._showLandingScreen();
  }

  // ── Peer cards ─────────────────────────────────────────────────────────

  _addParticipantCard(peerId, isLocal = false, name = null) {
    const domId = isLocal ? 'peer-local' : `peer-${peerId}`;
    if (document.getElementById(domId)) return;

    const displayName = name || (isLocal ? 'You' : `Peer ${peerId.slice(0, 4).toUpperCase()}`);
    const initials    = displayName.slice(0, 2).toUpperCase();
    // shadow `name` with displayName for the template below
    name = displayName;
    const statusTxt = isLocal ? 'Speaking' : 'Connecting…';
    const statusCls = isLocal ? 'peer-status ok' : 'peer-status';

    const card = document.createElement('div');
    card.id        = domId;
    card.className = 'participant' + (isLocal ? ' connected' : '');
    card.innerHTML = `
      <div class="avatar ${isLocal ? 'local' : ''}">${initials}</div>
      <div class="peer-info">
        <div class="peer-name">${name}</div>
        <div class="${statusCls}">${statusTxt}</div>
      </div>
      <div class="vol-bar" id="vol-${isLocal ? 'local' : peerId}">
        <div class="vol-seg"></div>
        <div class="vol-seg"></div>
        <div class="vol-seg"></div>
        <div class="vol-seg"></div>
      </div>`;
    $('participants-list').appendChild(card);
    this._updateCount();
  }

  _updatePeerStatus(peerId, state) {
    const card = document.getElementById(`peer-${peerId}`);
    if (!card) return;
    const status = card.querySelector('.peer-status');
    if (state === 'connected') {
      card.classList.add('connected');
      status.textContent = 'Connected';
      status.className   = 'peer-status ok';
    } else if (state === 'failed' || state === 'disconnected') {
      card.classList.remove('connected');
      status.textContent = state.charAt(0).toUpperCase() + state.slice(1);
      status.className   = 'peer-status';
    }
  }

  _removePeer(peerId) {
    const pc = this.peers.get(peerId);
    if (pc) { pc.close(); this.peers.delete(peerId); }

    const audio = this.audioEls.get(peerId);
    if (audio) { audio.srcObject = null; audio.remove(); this.audioEls.delete(peerId); }

    this.analysers.delete(peerId);
    this.audioSourceNodes.delete(peerId);
    document.getElementById(`peer-${peerId}`)?.remove();
    this._updateCount();
  }

  _updateCount() {
    $('participant-count').textContent = $('participants-list').children.length;
  }

  // ── Voice activity visualization ───────────────────────────────────────

  _startVAD() {
    const buf = new Uint8Array(32);
    const tick = () => {
      this.analysers.forEach((analyser, peerId) => {
        analyser.getByteFrequencyData(buf);
        const rms = buf.reduce((s, v) => s + v, 0) / buf.length;
        const level = Math.min(4, Math.floor(rms / 8));
        const volId = peerId === 'local' ? 'vol-local' : `vol-${peerId}`;
        const volBar = document.getElementById(volId);
        if (!volBar) return;
        const segs = volBar.querySelectorAll('.vol-seg');
        segs.forEach((seg, i) => seg.classList.toggle('active', i < level));

        // Speaking indicator on card
        const cardId = peerId === 'local' ? 'peer-local' : `peer-${peerId}`;
        const card = document.getElementById(cardId);
        if (card) card.classList.toggle('speaking', level > 1);
      });
      this._vadLoop = requestAnimationFrame(tick);
    };
    tick();
  }

  // ── Timer ──────────────────────────────────────────────────────────────

  _startTimer() {
    this._timerStart = Date.now();
    this._timerInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - this._timerStart) / 1000);
      const m = String(Math.floor(elapsed / 60)).padStart(2, '0');
      const s = String(elapsed % 60).padStart(2, '0');
      $('call-timer').textContent = `${m}:${s}`;
    }, 1000);
  }

  // ── Keyboard / viewport handling ───────────────────────────────────────

  _handleKeyboard() {
    const vv = window.visualViewport;
    if (!vv) return;
    // How many px the keyboard is covering at the bottom of the layout viewport
    const offset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    $('call-screen').style.transform = offset > 0 ? `translateY(-${offset}px)` : '';
    if (this._chatOpen && offset > 0) {
      requestAnimationFrame(() => {
        $('chat-messages').scrollTop = $('chat-messages').scrollHeight;
      });
    }
  }

  // ── Chat ───────────────────────────────────────────────────────────────

  _toggleChat() {
    this._chatOpen = !this._chatOpen;
    $('chat-panel').classList.toggle('hidden', !this._chatOpen);
    $('participants-section').classList.toggle('hidden', this._chatOpen);
    $('chat-btn').dataset.active = this._chatOpen ? 'true' : 'false';
    if (this._chatOpen) {
      this._unreadCnt = 0;
      $('chat-badge').classList.add('hidden');
      const msgs = $('chat-messages');
      msgs.scrollTop = msgs.scrollHeight;
      $('chat-input').focus();
    }
  }

  _sendChat() {
    const text = $('chat-input').value.trim();
    if (!text || !this.roomId) return;
    $('chat-input').value = '';
    this._addChatMessage(this.myName || 'You', text, true);
    this._send({ type: 'chat', text });
  }

  _addChatMessage(name, text, isLocal) {
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const wrap = document.createElement('div');
    wrap.className = `chat-msg ${isLocal ? 'chat-msg-local' : 'chat-msg-remote'}`;

    if (!isLocal) {
      const sender = document.createElement('div');
      sender.className = 'chat-sender';
      sender.textContent = name;
      wrap.appendChild(sender);
    }

    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble';
    bubble.textContent = text;
    wrap.appendChild(bubble);

    const meta = document.createElement('div');
    meta.className = 'chat-meta';
    meta.textContent = isLocal ? `You · ${time}` : time;
    wrap.appendChild(meta);

    const msgs = $('chat-messages');
    msgs.appendChild(wrap);
    msgs.scrollTop = msgs.scrollHeight;

    if (!isLocal) {
      if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
      if (!this._chatOpen) {
        this._unreadCnt++;
        const badge = $('chat-badge');
        badge.textContent = this._unreadCnt > 9 ? '9+' : String(this._unreadCnt);
        badge.classList.remove('hidden');
      }
    }
  }

  // ── Screen switching ───────────────────────────────────────────────────

  _showCallScreen() {
    $('landing-screen').classList.remove('active');
    $('call-screen').classList.add('active');
    $('room-code-display').textContent = this.roomId;
    $('participants-list').innerHTML = '';
    // Reset chat state for new call
    this._chatOpen  = false;
    this._unreadCnt = 0;
    $('chat-messages').innerHTML = '';
    $('chat-panel').classList.add('hidden');
    $('participants-section').classList.remove('hidden');
    $('chat-btn').dataset.active = 'false';
    $('chat-badge').classList.add('hidden');
    $('speaker-btn').classList.remove('muted');
    $('speaker-label').textContent = 'Sound';
    $('speaker-ico').innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
        <path d="M15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14"/>
      </svg>`;
    this._addParticipantCard(this.peerId, true, this.myName || 'You');
    this._startTimer();
    this._startVAD();
    window.visualViewport?.addEventListener('resize', this._boundHandleKeyboard);
  }

  _showLandingScreen() {
    $('call-screen').classList.remove('active');
    $('landing-screen').classList.add('active');
    $('room-code-input').value = '';
    $('call-timer').textContent = '00:00';
    $('participants-list').innerHTML = '';
    clearError();
  }

  // ── Room actions ───────────────────────────────────────────────────────

  _initAudioContext() {
    // Must be called directly inside a tap handler so iOS grants audio permission
    if (!this.audioCtx) {
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    this.audioCtx.resume().catch(() => {});
  }

  async _createRoom() {
    const name = $('name-input').value.trim();
    if (!name) { showError('Please enter your name.'); return; }
    this.myName = name;
    this._initAudioContext(); // create while still inside the tap gesture
    try {
      await this._connect();
      this._send({ type: 'create-room', peerId: this.peerId, name });
    } catch {
      showError('Could not connect to server. Is it running?');
    }
  }

  async _joinRoom() {
    const name = $('name-input').value.trim();
    if (!name) { showError('Please enter your name.'); return; }
    const code = $('room-code-input').value.trim();
    if (code.length !== 3) { showError('Enter a valid 3-digit room code.'); return; }
    this.myName = name;
    this._initAudioContext(); // create while still inside the tap gesture
    try {
      await this._connect();
      this._send({ type: 'join-room', roomId: code, peerId: this.peerId, name });
    } catch {
      showError('Could not connect to server. Is it running?');
    }
  }

  _copyRoomCode() {
    navigator.clipboard.writeText(this.roomId).then(
      () => toast(`Room code ${this.roomId} copied!`),
      () => toast('Could not copy — share code: ' + this.roomId),
    );
  }

  _onWsClose() {
    if (this.roomId) {
      toast('Connection lost.', 4000);
    }
  }
}

// ── Boot ────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => { window.app = new PhoneConf(); });
