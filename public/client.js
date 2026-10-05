/* Clube do Pife — cliente.
 * Regras: nada de innerHTML com dados de jogadores (tudo via DOM/textContent) e nada de handlers inline,
 * assim o conteúdo enviado por outros jogadores nunca vira código (antes era possível XSS pelo chat/nome). */
(() => {
    'use strict';

    const R = window.PifeRules;
    const AVATARS = ['🤠', '👽', '🤖', '🦊', '😎', '🤡'];
    const EMOTES = ['😂', '😡', '🍻', '💔', '😎', '😭', '👏', '🤔'];
    const THEMES = { green: '#1a472a', blue: '#0b2e59', red: '#7b1113', black: '#121212' };

    /* ---------- utilidades ---------- */
    const $ = (id) => document.getElementById(id);

    function el(tag, attrs, ...kids) {
        const n = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs || {})) {
            if (v == null || v === false) continue;
            if (k === 'class') n.className = v;
            else if (k === 'text') n.textContent = v;
            else if (k === 'dataset') Object.assign(n.dataset, v);
            else if (k === 'on') for (const [ev, fn] of Object.entries(v)) n.addEventListener(ev, fn);
            else n.setAttribute(k, v === true ? '' : v);
        }
        for (const kid of kids.flat()) {
            if (kid == null || kid === false) continue;
            n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
        }
        return n;
    }
    const mkStore = (area) => ({
        get(k) { try { return area.getItem(k); } catch (e) { return null; } },
        set(k, v) { try { area.setItem(k, v); } catch (e) { /* modo privado */ } },
        del(k) { try { area.removeItem(k); } catch (e) { /* ignore */ } },
    });
    const ls = mkStore(window.localStorage);
    const ss = mkStore(window.sessionStorage);

    function newGuestId() {
        const a = new Uint8Array(16);
        crypto.getRandomValues(a);
        return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
    }
    const getGuest = () => { try { return JSON.parse(ss.get('pife_guest') || 'null'); } catch (e) { return null; } };

    /* ---------- estado ---------- */
    let profile = null;            // { type, name, avatar, wins }
    let game = null;               // último gameState
    let localHand = [];            // mão na ordem escolhida pelo jogador
    let selectedId = null;
    let layout = ['overlap', 'fan', 'flat'].includes(ls.get('pife_layout')) ? ls.get('pife_layout') : 'overlap';
    let muted = ls.get('pife_mute') === '1';
    let chosenAvatar = ls.get('pife_avatar') && AVATARS.includes(ls.get('pife_avatar')) ? ls.get('pife_avatar') : AVATARS[0];
    let upgradeMode = false;
    let screen = 'splash';
    let joinSeq = 0;
    let lastRoomId = null;
    let wasMyTurn = false;
    let chatOpen = false;
    let drag = null;
    let pendingState = null;

    const socket = io();

    function ask(ev, payload) {
        return new Promise((resolve) => {
            socket.timeout(8000).emit(ev, payload, (err, res) => {
                resolve(err ? { ok: false, error: 'O servidor não respondeu. Tente de novo.', timeout: true } : res);
            });
        });
    }

    /* ---------- telas ---------- */
    const SCREENS = { splash: 'splash', auth: 'screen-auth', lobby: 'screen-lobby', game: 'screen-game' };
    function show(name) {
        screen = name;
        Object.entries(SCREENS).forEach(([k, id]) => $(id).classList.toggle('active', k === name));
        window.scrollTo(0, 0);
    }

    /* ---------- toast, modal, som, confete ---------- */
    let toastTimer = null;
    function toast(msg, ms) {
        const t = $('toast');
        t.textContent = msg;
        t.classList.add('show');
        clearTimeout(toastTimer);
        const dur = ms === undefined ? Math.min(7000, 2200 + msg.length * 35) : ms;
        if (dur > 0) toastTimer = setTimeout(() => t.classList.remove('show'), dur);
    }
    function hideToast() { clearTimeout(toastTimer); $('toast').classList.remove('show'); }

    let modalClose = null;
    function openModal(children, { cls = '', dismissable = true, onClose } = {}) {
        closeModal();
        const modal = el('div', { class: `modal ${cls}`, role: 'dialog', 'aria-modal': 'true' }, children);
        const back = el('div', { class: 'modal-backdrop' }, modal);
        const close = () => { back.remove(); modalClose = null; if (onClose) onClose(); };
        if (dismissable) back.addEventListener('pointerdown', (e) => { if (e.target === back) close(); });
        $('modal-root').append(back);
        modalClose = close;
        const first = modal.querySelector('input, button');
        if (first) first.focus({ preventScroll: true });
        return close;
    }
    function closeModal() { if (modalClose) modalClose(); }

    function alertDialog(msg, title = 'Aviso') {
        return new Promise((resolve) => {
            openModal([
                el('h3', { text: title }), el('p', { text: msg }),
                el('div', { class: 'actions' }, el('button', { class: 'btn primary', type: 'button', on: { click: () => closeModal() } }, 'OK')),
            ], { onClose: resolve });
        });
    }
    function confirmDialog(msg, { title = 'Confirmação', yes = 'Sim', no = 'Cancelar', danger = false } = {}) {
        return new Promise((resolve) => {
            let answer = false;
            openModal([
                el('h3', { text: title }), el('p', { text: msg }),
                el('div', { class: 'actions' },
                    el('button', { class: 'btn ghost', type: 'button', on: { click: () => closeModal() } }, no),
                    el('button', { class: `btn ${danger ? 'danger' : 'primary'}`, type: 'button', on: { click: () => { answer = true; closeModal(); } } }, yes)),
            ], { dismissable: false, onClose: () => resolve(answer) });
        });
    }
    function promptDialog({ title, label, type = 'password' }) {
        return new Promise((resolve) => {
            let value = null;
            const input = el('input', { type, maxlength: 64, autocomplete: 'off' });
            const form = el('form', {
                on: { submit: (e) => { e.preventDefault(); value = input.value; closeModal(); } },
            }, el('h3', { text: title }), el('label', { class: 'field' }, el('span', { text: label }), input),
            el('div', { class: 'actions' },
                el('button', { class: 'btn ghost', type: 'button', on: { click: () => closeModal() } }, 'Cancelar'),
                el('button', { class: 'btn primary', type: 'submit' }, 'Entrar')));
            openModal(form, { dismissable: false, onClose: () => resolve(value) });
        });
    }

    let audioCtx = null;
    let userGesture = false;
    ['pointerdown', 'keydown', 'touchstart'].forEach((ev) => window.addEventListener(ev, () => { userGesture = true; }, { capture: true, once: true }));
    function sfx(type) {
        if (muted || !userGesture) return;
        try {
            audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
            if (audioCtx.state === 'suspended') audioCtx.resume();
            const t = audioCtx.currentTime;
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.connect(gain); gain.connect(audioCtx.destination);
            const tone = (wave, f0, f1, vol, dur) => {
                osc.type = wave;
                osc.frequency.setValueAtTime(f0, t);
                if (f1) osc.frequency.exponentialRampToValueAtTime(f1, t + dur);
                gain.gain.setValueAtTime(vol, t);
                gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
                osc.start(t); osc.stop(t + dur);
            };
            if (type === 'draw') tone('sine', 300, 500, 0.1, 0.12);
            else if (type === 'discard') tone('triangle', 400, 200, 0.1, 0.12);
            else if (type === 'turn') tone('sine', 660, 880, 0.07, 0.3);
            else if (type === 'pop') tone('sine', 800, 1200, 0.08, 0.12);
            else if (type === 'win') tone('square', 440, 660, 0.08, 0.45);
        } catch (e) { /* sem áudio */ }
    }

    function confetti() {
        if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        const cv = $('confetti');
        const dpr = window.devicePixelRatio || 1;
        cv.width = window.innerWidth * dpr;
        cv.height = window.innerHeight * dpr;
        const ctx = cv.getContext('2d');
        const colors = ['#c5a85b', '#ffffff', '#ff5252', '#4fc3f7', '#3ddc97'];
        const parts = Array.from({ length: 140 }, () => ({
            x: Math.random() * cv.width, y: -Math.random() * cv.height * 0.5,
            vx: (Math.random() - 0.5) * 4 * dpr, vy: (2 + Math.random() * 4) * dpr,
            s: (5 + Math.random() * 7) * dpr, r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.3,
            c: colors[Math.floor(Math.random() * colors.length)],
        }));
        const end = Date.now() + 3200;
        (function frame() {
            ctx.clearRect(0, 0, cv.width, cv.height);
            parts.forEach((p) => {
                p.x += p.vx; p.y += p.vy; p.r += p.vr;
                ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r);
                ctx.fillStyle = p.c; ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2); ctx.restore();
            });
            if (Date.now() < end) requestAnimationFrame(frame); else ctx.clearRect(0, 0, cv.width, cv.height);
        })();
    }

    /* ---------- cartas (DOM) ---------- */
    function cardNode(card, { wild = false, extra = '' } = {}) {
        const red = card.suit === '♥' || card.suit === '♦';
        const mini = (cls) => el('div', { class: cls }, card.value, el('br'), card.suit);
        return el('div', {
            class: `card ${red ? 'red' : 'black'}${wild ? ' is-wildcard' : ''} ${extra}`.trim(),
            role: 'img', 'aria-label': R.cardLabel(card) + (wild ? ' (curinga)' : ''), dataset: { id: card.id },
        }, mini('card-mini'), el('div', { class: 'card-center', text: card.suit }), mini('card-mini-bottom'));
    }
    const backCard = (count) => el('div', { class: 'card back' }, 'Monte', count != null ? el('div', { class: 'deck-count-badge', text: String(count) }) : null);
    const emptyCard = (text) => el('div', { class: 'card empty', text });

    /* ====================================================================== */
    /*  AUTENTICAÇÃO                                                           */
    /* ====================================================================== */
    const TAB_HINTS = {
        guest: 'Sem cadastro. Suas vitórias valem só enquanto esta sessão durar e são apagadas quando você sair.',
        login: 'Entre na sua conta para jogar com suas vitórias de sempre, em qualquer aparelho.',
        signup: 'Crie uma conta para guardar suas vitórias e usar o mesmo nome em qualquer aparelho. Não precisa de e-mail.',
    };

    function setTab(tab) {
        document.querySelectorAll('.tab').forEach((b) => {
            const on = b.dataset.tab === tab;
            b.classList.toggle('active', on);
            b.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        $('form-guest').hidden = tab !== 'guest';
        $('form-login').hidden = tab !== 'login';
        $('form-signup').hidden = tab !== 'signup';
        let hint = TAB_HINTS[tab];
        if (tab === 'signup' && upgradeMode && profile) hint = `Suas ${profile.wins} vitória(s) desta sessão serão levadas para a conta nova.`;
        $('auth-hint').textContent = hint;
        $('auth-error').textContent = '';
    }

    function buildAvatarPickers() {
        const render = () => document.querySelectorAll('[data-picker]').forEach((box) => {
            box.replaceChildren(...AVATARS.map((a) => el('button', {
                type: 'button', role: 'radio', 'aria-checked': a === chosenAvatar ? 'true' : 'false', 'aria-label': `Avatar ${a}`,
                on: { click: () => { chosenAvatar = a; ls.set('pife_avatar', a); render(); } },
            }, a)));
        });
        render();
    }

    function onAuthed(p, seqBefore = joinSeq) {
        profile = p;
        $('auth-error').textContent = '';
        if (screen === 'game') {
            // reconectou durante uma partida: o servidor devolve para a mesa ('joined'); se a mesa sumiu, volta ao saguão.
            // seqBefore foi lido ANTES do pedido: o 'joined' pode chegar junto com a resposta, antes deste código rodar.
            if (joinSeq !== seqBefore) return;
            setTimeout(() => { if (joinSeq === seqBefore && screen === 'game') toLobby('A mesa não existe mais (o servidor reiniciou ou você foi removido).'); }, 1800);
            return;
        }
        if (joinSeq !== seqBefore) return; // já foi levado de volta para a mesa
        renderLobby();
        show('lobby');
    }

    async function resumeSession() {
        const seq = joinSeq;
        const token = ls.get('pife_token');
        if (token) {
            const r = await ask('auth', { mode: 'token', token });
            if (r.ok) return onAuthed(r.profile, seq);
            if (r.expired) ls.del('pife_token');
            else if (r.timeout) return;
        }
        const g = getGuest();
        if (g && !ls.get('pife_token')) {
            const r = await ask('auth', { mode: 'guest', guestId: g.id, nick: g.nick, avatar: g.avatar });
            if (r.ok) return onAuthed(r.profile, seq);
            if (r.timeout) return;
            ss.del('pife_guest');
        }
        if (screen !== 'game') { profile = null; show('auth'); setTab('guest'); }
    }

    function bindAuthForms() {
        document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
        $('guest-nick').value = ls.get('pife_nick') || '';

        $('form-guest').addEventListener('submit', async (e) => {
            e.preventDefault();
            const nick = $('guest-nick').value.trim();
            const g = getGuest() || { id: newGuestId() };
            const r = await ask('auth', { mode: 'guest', guestId: g.id, nick, avatar: chosenAvatar });
            if (!r.ok) { $('auth-error').textContent = r.error; return; }
            ls.del('pife_token');
            ls.set('pife_nick', nick);
            ss.set('pife_guest', JSON.stringify({ id: g.id, nick, avatar: chosenAvatar }));
            onAuthed(r.profile);
        });

        $('form-login').addEventListener('submit', async (e) => {
            e.preventDefault();
            const r = await ask('auth', { mode: 'login', username: $('login-user').value.trim(), password: $('login-pass').value });
            if (!r.ok) { $('auth-error').textContent = r.error; return; }
            ls.set('pife_token', r.token);
            ss.del('pife_guest');
            $('login-pass').value = '';
            upgradeMode = false;
            onAuthed(r.profile);
        });

        $('form-signup').addEventListener('submit', async (e) => {
            e.preventDefault();
            const g = getGuest();
            const r = await ask('auth', {
                mode: 'signup', username: $('signup-user').value.trim(), password: $('signup-pass').value,
                avatar: chosenAvatar, guestId: g ? g.id : undefined,
            });
            if (!r.ok) { $('auth-error').textContent = r.error; return; }
            ls.set('pife_token', r.token);
            ss.del('pife_guest');
            $('signup-pass').value = '';
            upgradeMode = false;
            onAuthed(r.profile);
        });

        $('btn-auth-back').addEventListener('click', () => { upgradeMode = false; $('btn-auth-back').hidden = true; document.querySelector('.tabs').hidden = false; show('lobby'); });
    }

    /* ====================================================================== */
    /*  SAGUÃO                                                                 */
    /* ====================================================================== */
    function renderLobby() {
        if (!profile) return;
        const guest = profile.type === 'guest';
        $('lobby-avatar').textContent = profile.avatar;
        $('lobby-name').textContent = profile.name;
        $('lobby-kind').textContent = guest ? 'Convidado (sem conta)' : 'Conta registrada';
        $('lobby-wins').textContent = `🏆 ${profile.wins}`;
        $('lobby-note').textContent = guest
            ? 'Suas vitórias valem só nesta sessão e somem quando você sair. Crie uma conta para guardá-las.'
            : 'Suas vitórias ficam salvas na conta e aparecem em qualquer aparelho.';
        $('btn-upgrade').hidden = !guest;
        $('join-room').value = ls.get('pife_room') || '';
    }

    function renderRooms(list) {
        const ul = $('room-list');
        if (!list.length) { ul.replaceChildren(el('li', { class: 'room-empty', text: 'Nenhuma sala aberta. Crie a sua acima!' })); return; }
        ul.replaceChildren(...list.map((r) => {
            const li = el('li', { class: 'room-item', tabindex: '0', role: 'button' },
                el('span', { text: r.hasPassword ? '🔒' : '🟢' }),
                el('span', { class: 'name', text: r.id }),
                r.playing ? el('span', { class: 'room-badge', text: 'em jogo' }) : null,
                el('span', { class: 'room-badge', text: `${r.count}/4` }));
            const go = async () => {
                $('join-room').value = r.id;
                let password = '';
                if (r.hasPassword) {
                    password = await promptDialog({ title: `Sala ${r.id}`, label: 'Esta sala tem senha:' });
                    if (password === null) return;
                }
                joinRoom(r.id, password);
            };
            li.addEventListener('click', go);
            li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
            return li;
        }));
    }

    async function joinRoom(room, password) {
        const name = (room || '').trim() || 'MESA1';
        ls.set('pife_room', name);
        const r = await ask('join_room', { room: name, password: password || '' });
        if (!r.ok) alertDialog(r.error);
        else $('join-pass').value = '';
    }

    function toLobby(msg) {
        game = null; localHand = []; selectedId = null; wasMyTurn = false; lastRoomId = null; pendingState = null;
        closeModal(); setChat(false); hideGameOver();
        renderLobby();
        show('lobby');
        if (msg) alertDialog(msg);
    }

    async function doLogout() {
        if (!profile) return;
        const guest = profile.type === 'guest';
        const ok = await confirmDialog(
            guest ? `Ao sair, suas ${profile.wins} vitória(s) desta sessão serão apagadas. Para guardá-las, crie uma conta. Sair mesmo assim?`
                : 'Sair da sua conta neste aparelho? Suas vitórias continuam salvas.',
            { title: 'Sair', yes: 'Sair', danger: guest });
        if (!ok) return;
        await ask('logout', { token: ls.get('pife_token') || undefined });
        ls.del('pife_token'); ss.del('pife_guest');
        profile = null; upgradeMode = false;
        game = null; localHand = [];
        $('btn-auth-back').hidden = true; document.querySelector('.tabs').hidden = false;
        show('auth'); setTab('guest');
    }

    /* ====================================================================== */
    /*  MESA                                                                   */
    /* ====================================================================== */
    const myTurn = () => !!game && game.status === 'playing' && game.turnPid === game.me.pid;
    const canDraw = () => myTurn() && !game.paused && game.phase === 'draw';
    const canDiscard = () => myTurn() && !game.paused && game.phase === 'discard';
    
    function whyNotDraw() {
        if (!game || game.status !== 'playing') return 'A partida ainda não começou.';
        if (game.paused) return 'Jogo pausado: um jogador caiu.';
        if (!myTurn()) return 'Ainda não é a sua vez.';
        if (game.phase !== 'draw') return 'Você já comprou: agora descarte uma carta.';
        return '';
    }

    function applyState(state) {
        const prev = game;
        game = state;
        if (!prev || prev.roomId !== state.roomId) { localHand = []; selectedId = null; }

        const ids = new Set(state.me.hand.map((c) => c.id));
        localHand = localHand.filter((c) => ids.has(c.id));
        const have = new Set(localHand.map((c) => c.id));
        const fresh = new Set();
        state.me.hand.forEach((c) => { if (!have.has(c.id)) { localHand.push(c); fresh.add(c.id); } });
        if (selectedId && !ids.has(selectedId)) selectedId = null;

        if (profile) { profile.wins = state.me.wins; }
        const mine = myTurn();
        if (mine && !wasMyTurn && !state.paused) { toast('✨ É a sua vez!', 1800); sfx('turn'); }
        wasMyTurn = mine;

        $('display-room-name').textContent = state.roomId;
        renderTop(); renderStatus(); renderHint(); renderOpponents(); renderTable(); renderHand(fresh); renderMeld(); renderActions();
    }

    function handleState(state) {
        if (drag) { pendingState = state; return; }
        applyState(state);
    }

    function renderTop() {
        const m = game.me;
        $('player-name').replaceChildren(`${game.isAdmin ? '👑 ' : ''}${m.avatar} ${m.name} `, el('span', { class: 'trophy', text: `🏆 ${m.wins}` }));
        $('btn-start').style.display = game.status === 'waiting' && game.isAdmin ? 'block' : 'none';
        $('btn-start').disabled = game.players.length < 2;
        $('btn-reset').style.display = game.isAdmin ? 'block' : 'none';
    }

    function renderStatus() {
        const st = $('status-message');
        st.classList.remove('my-turn-glow');
        st.style.color = '';
        if (game.status === 'waiting') st.textContent = 'Aguardando Início...';
        else if (game.paused) { st.textContent = 'JOGO PAUSADO'; st.style.color = '#ff4a4a'; }
        else if (myTurn()) { st.textContent = game.phase === 'draw' ? 'SUA VEZ: Compre' : 'SUA VEZ: Descarte'; st.classList.add('my-turn-glow'); }
        else st.textContent = 'Aguarde o oponente';
    }

    function countdownNode(at) {
        return el('b', { class: 'cd', dataset: { at: String(at || 0) }, text: '…' });
    }

    function renderHint() {
        const hint = $('hint');
        hint.className = 'hintbar';
        hint.replaceChildren();
        const s = game;
        if (s.status === 'waiting') {
            const n = s.players.length;
            if (s.isAdmin) {
                hint.append(el('span', {}, n < 2
                    ? ['Você é o administrador 👑. Chame alguém: diga o nome da sala ', el('b', { text: s.roomId }), ' (2 a 4 jogadores).']
                    : ['Todos prontos? Toque em ', el('b', { text: 'Iniciar' }), ' quando quiser.']));
            } else {
                hint.append(el('span', {}, 'Aguardando o administrador 👑 iniciar a partida…'));
            }
            return;
        }
        if (s.paused) {
            hint.classList.add('warn');
            const off = s.players.filter((p) => !p.connected);
            hint.append(el('span', {}, 'Jogo pausado: aguardando ', el('b', { text: off.map((p) => p.name).join(', ') }),
                ' voltar (', countdownNode(Math.min(...off.map((p) => p.reconnectAt || Infinity))), 's).'));
            updateCountdowns();
            return;
        }
        if (myTurn()) {
            hint.classList.add('mine');
            if (s.phase === 'draw') {
                hint.append(el('span', {}, [el('b', { text: 'Sua vez · 1º passo: ' }), 'compre uma carta, do ', el('b', { text: 'Monte' }), ' (fechada) ou do ', el('b', { text: 'Lixo' }), ' (a carta aberta).']));
            } else {
                hint.append(el('span', {}, [el('b', { text: 'Sua vez · 2º passo: ' }), 'toque numa carta e em ', el('b', { text: 'Descartar' }),
                    ' (ou arraste até o Lixo). Com 3 jogos prontos, toque em ', el('b', { text: 'BATER!' }), s.me.lockedDiscardId ? ' A carta que você pegou do Lixo não pode voltar agora.' : '']));
            }
            return;
        }
        const cur = s.players.find((p) => p.pid === s.turnPid);
        hint.append(el('span', {}, cur ? `Vez de ${cur.avatar} ${cur.name}… organize suas cartas enquanto espera.` : 'Aguarde…'));
    }

    function updateCountdowns() {
        document.querySelectorAll('.cd').forEach((n) => {
            const at = Number(n.dataset.at);
            n.textContent = Number.isFinite(at) && at > 0 ? String(Math.max(0, Math.ceil((at - Date.now()) / 1000))) : '…';
        });
    }

    function renderOpponents() {
        const box = $('opponents-area');
        box.replaceChildren(...game.players.filter((p) => !p.isMe).map((p) => {
            const turn = game.status === 'playing' && game.turnPid === p.pid && p.connected;
            return el('div', { class: `opponent${turn ? ' is-turn' : ''}${p.connected ? '' : ' offline'}`, dataset: { pid: p.pid } },
                game.isAdmin ? el('button', { class: 'kick-btn', type: 'button', title: 'Expulsar Jogador', 'aria-label': `Expulsar ${p.name}`, text: '❌', on: { click: () => kickPlayer(p) } }) : null,
                turn ? el('div', { class: 'turn-badge', text: 'Vez Dele' }) : null,
                !p.connected ? el('div', { class: 'offline-tag' }, 'Caiu · ', countdownNode(p.reconnectAt), 's') : null,
                el('h3', { text: `${p.isAdmin ? '👑 ' : ''}${p.avatar} ${p.name}` }),
                el('div', {}, el('span', { class: 'trophy', text: `🏆 ${p.wins}` })),
                game.status === 'playing' ? el('p', { text: `${p.cards} cartas` }) : null);
        }));
        updateCountdowns();
    }

    async function kickPlayer(p) {
        const ok = await confirmDialog(`Expulsar ${p.name} da sala?`, { yes: 'Expulsar', danger: true });
        if (ok) socket.emit('kick_player', p.pid);
    }

    function renderTable() {
        const s = game;
        const draw = canDraw();
        const playing = s.status === 'playing';
        $('deck-container').replaceChildren(playing ? backCard(s.deckCount) : emptyCard('Monte'));
        $('wildcard-container').replaceChildren(s.wildcardCard ? cardNode(s.wildcardCard) : emptyCard('Morta'));
        $('wildcard-badge').hidden = !s.wildcardValue;
        $('wildcard-text').textContent = s.wildcardValue || '-';
        $('discard-container').replaceChildren(s.discardTop ? cardNode(s.discardTop, { wild: !!s.wildcardValue && s.discardTop.value === s.wildcardValue }) : emptyCard(playing ? 'Vazio' : 'Lixo'));
        ['pile-deck', 'pile-discard'].forEach((id) => {
            $(id).classList.toggle('can-draw', draw);
            $(id).classList.toggle('locked', playing && !draw);
        });
    }

    /* ----- mão ----- */
    function computeMelds() {
        if (!game || game.status !== 'playing' || !game.wildcardValue || localHand.length < 3) return { groups: [], rest: localHand.slice(), count: 0 };
        return R.bestMelds(localHand, game.wildcardValue);
    }

    function renderHand(fresh = new Set()) {
        const hand = $('my-hand');
        const lay = layout;
        hand.className = `hand-area layout-${lay}`;
        const melds = computeMelds();
        const groupOf = new Map();
        melds.groups.forEach((g, gi) => g.forEach((c) => groupOf.set(c.id, gi)));
        const winnable = localHand.length === 10 && melds.count === 3;
        const wv = game ? game.wildcardValue : null;
        const n = localHand.length;

        hand.replaceChildren(...localHand.map((card, i) => {
            const node = cardNode(card, { wild: !!wv && card.value === wv });
            node.tabIndex = 0;
            node.style.zIndex = String(i);
            if (groupOf.has(card.id)) node.dataset.g = String(groupOf.get(card.id));
            if (winnable && !groupOf.has(card.id)) node.classList.add('loose');
            if (card.id === selectedId) node.classList.add('selected');
            if (fresh.has(card.id)) node.classList.add('fresh');
            if (lay === 'fan') node.style.setProperty('--rot', `${((i - (n - 1) / 2) * 5).toFixed(1)}deg`);
            return node;
        }));
    }

    function renderMeld() {
        const box = $('meld-status');
        box.replaceChildren();
        if (!game || game.status !== 'playing' || !localHand.length) return;
        const m = computeMelds();
        const dots = el('span', { class: 'meld-dots', 'aria-hidden': 'true' }, [0, 1, 2].map((i) => el('i', { class: i < m.count ? `on g${i}` : '' })));
        let text;
        if (m.count === 3 && localHand.length === 10) text = el('span', { class: 'ready', text: '✅ Jogos prontos! Toque em BATER!' });
        else if (m.count === 3) text = el('span', { class: 'ready', text: myTurn() ? '✅ 3 jogos prontos! Compre uma carta e bata.' : '✅ 3 jogos prontos! Espere a sua vez.' });
        else text = el('span', { text: `${m.count} de 3 jogos prontos` });
        box.append(dots, text);
    }

    function renderActions() {
        document.querySelectorAll('.layout-btn').forEach((b) => b.setAttribute('aria-pressed', b.dataset.layout === layout ? 'true' : 'false'));
        $('btn-sort').classList.toggle('disabled', localHand.length < 2);
        const disc = $('btn-discard'); const bat = $('btn-bater');
        const sel = localHand.find((c) => c.id === selectedId);
        disc.textContent = sel ? `Descartar ${sel.value}${sel.suit}` : 'Descartar';
        const canD = canDiscard() && !!sel;
        disc.classList.toggle('ready', canD);
        disc.classList.toggle('disabled', !canD);
        bat.classList.toggle('ready', canDiscard() && localHand.length === 10 && computeMelds().count === 3);
        bat.classList.toggle('disabled', !canDiscard());
    }

    function toggleSelect(id) {
        selectedId = selectedId === id ? null : id;
        document.querySelectorAll('#my-hand .card').forEach((c) => c.classList.toggle('selected', c.dataset.id === selectedId));
        renderActions();
    }

    function tryDiscard(id) {
        if (!game || game.status !== 'playing') return toast('A partida ainda não começou.');
        if (game.paused) return toast('Jogo pausado: um jogador caiu.');
        if (!myTurn()) return toast('Ainda não é a sua vez.');
        if (game.phase !== 'discard') return toast('Compre uma carta primeiro (Monte ou Lixo).');
        if (id === game.me.lockedDiscardId) return toast('Você acabou de pegar essa carta do Lixo. Descarte outra.');
        socket.emit('discard', id);
        selectedId = null;
    }

    function autoSort() {
        if (localHand.length < 2) return;
        const m = computeMelds();
        const rest = R.sortCards(m.rest);
        localHand = [...m.groups.flat(), ...rest];
        renderHand(); renderActions();
        toast(m.count ? `🪄 Organizei: ${m.count} jogo(s) pronto(s) à esquerda, com faixas coloridas.` : '🪄 Cartas ordenadas por naipe e valor. Ainda não há jogos prontos.');
    }

    /* ----- arrastar e soltar (Pointer Events: mouse e toque) ----- */
    const overDiscard = (x, y) => {
        const r = $('pile-discard').getBoundingClientRect();
        return x >= r.left - 24 && x <= r.right + 24 && y >= r.top - 24 && y <= r.bottom + 24;
    };

    function onHandPointerDown(e) {
        const cardEl = e.target.closest('.card');
        if (!cardEl || drag || (e.pointerType === 'mouse' && e.button !== 0)) return;
        drag = { id: cardEl.dataset.id, el: cardEl, pointerId: e.pointerId, x0: e.clientX, y0: e.clientY, moved: false, ghost: null, marker: null, insertIndex: null, discard: false };
        try { cardEl.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        cardEl.addEventListener('pointermove', onDragMove);
        cardEl.addEventListener('pointerup', onDragEnd);
        cardEl.addEventListener('pointercancel', onDragEnd);
    }

    function startGhost(e) {
        const rect = drag.el.getBoundingClientRect();
        const ghost = drag.el.cloneNode(true);
        ghost.classList.remove('selected', 'fresh', 'loose', 'dragging-origin');
        ghost.removeAttribute('data-g');
        ghost.classList.add('ghost-card');
        ghost.style.setProperty('--cw', `${rect.width}px`);
        document.body.append(ghost);
        drag.ghost = ghost;
        drag.w = rect.width; drag.h = rect.height;
        drag.el.classList.add('dragging-origin');
        drag.marker = el('div', { class: 'drop-marker' });
        $('my-hand').append(drag.marker);
    }

    function onDragMove(e) {
        if (!drag || e.pointerId !== drag.pointerId) return;
        if (!drag.moved) {
            if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < (e.pointerType === 'mouse' ? 4 : 10)) return;
            drag.moved = true;
            startGhost(e);
        }
        drag.ghost.style.left = `${e.clientX - drag.w / 2}px`;
        drag.ghost.style.top = `${e.clientY - drag.h * 0.6}px`;

        drag.discard = overDiscard(e.clientX, e.clientY);
        $('pile-discard').classList.toggle('drop-target', drag.discard);
        const handEl = $('my-hand');
        const hr = handEl.getBoundingClientRect();
        const inHand = !drag.discard && e.clientY > hr.top - 70 && e.clientY < hr.bottom + 70;
        drag.insertIndex = null;
        drag.marker.style.display = 'none';
        if (!inHand) return;

        const others = [...handEl.querySelectorAll('.card')].filter((c) => c !== drag.el);
        if (!others.length) { drag.insertIndex = 0; return; }
        let best = 0; let bestD = Infinity;
        others.forEach((c, i) => {
            const r = c.getBoundingClientRect();
            const d = Math.hypot(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2));
            if (d < bestD) { bestD = d; best = i; }
        });
        const r = others[best].getBoundingClientRect();
        const after = e.clientX > r.left + r.width / 2;
        drag.insertIndex = best + (after ? 1 : 0);
        drag.marker.style.display = 'block';
        drag.marker.style.left = `${(after ? r.right : r.left) - hr.left + handEl.scrollLeft - 2}px`;
        drag.marker.style.top = `${r.top - hr.top}px`;
        drag.marker.style.height = `${r.height}px`;
    }

    function onDragEnd(e) {
        if (!drag || e.pointerId !== drag.pointerId) return;
        const d = drag;
        drag = null;
        d.el.removeEventListener('pointermove', onDragMove);
        d.el.removeEventListener('pointerup', onDragEnd);
        d.el.removeEventListener('pointercancel', onDragEnd);
        try { d.el.releasePointerCapture(d.pointerId); } catch (err) { /* ignore */ }
        if (d.ghost) d.ghost.remove();
        if (d.marker) d.marker.remove();
        d.el.classList.remove('dragging-origin');
        $('pile-discard').classList.remove('drop-target');

        if (e.type !== 'pointercancel') {
            if (!d.moved) {
                toggleSelect(d.id);
            } else if (d.discard) {
                tryDiscard(d.id);
            } else if (d.insertIndex !== null) {
                const moving = localHand.find((c) => c.id === d.id);
                const others = localHand.filter((c) => c.id !== d.id);
                if (moving) { others.splice(d.insertIndex, 0, moving); localHand = others; }
            }
        }
        if (pendingState) { const s = pendingState; pendingState = null; applyState(s); } else { renderHand(); renderMeld(); renderActions(); }
    }

    function cancelDrag() {
        if (!drag) return;
        onDragEnd({ type: 'pointercancel', pointerId: drag.pointerId });
    }

    /* ----- chat ----- */
    function setChat(open) {
        chatOpen = open;
        $('chat-panel').classList.toggle('mobile-open', open);
        if (open) { $('chat-dot').hidden = true; const m = $('chat-messages'); m.scrollTop = m.scrollHeight; }
    }

    function pushChat(node, countsAsUnread) {
        const box = $('chat-messages');
        const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
        box.append(node);
        while (box.children.length > 150) box.firstChild.remove();
        if (stick) box.scrollTop = box.scrollHeight;
        if (countsAsUnread && !chatOpen && window.innerWidth <= 850) $('chat-dot').hidden = false;
    }

    /* ----- menu, ajuda, fim de rodada ----- */
    function setTheme(name) {
        document.body.className = `theme-${name}`;
        ls.set('pife_theme', name);
        document.querySelector('meta[name="theme-color"]').setAttribute('content', THEMES[name]);
    }

    function updateSoundBtn() { $('btn-sound').textContent = muted ? '🔇' : '🔊'; }

    function openHelp() {
        const p = (t) => el('p', { text: t });
        openModal([
            el('h3', { text: 'Como jogar Pife' }),
            p('Objetivo: formar 3 jogos de 3 cartas com a sua mão. Joga-se com 2 baralhos, 2 a 4 pessoas, e cada um começa com 9 cartas.'),
            el('h4', { text: 'O que é um jogo' }),
            el('ul', {}, el('li', { text: 'Trinca: 3 cartas do mesmo valor e de naipes diferentes (7♥ 7♦ 7♠).' }),
                el('li', { text: 'Sequência: 3 cartas seguidas do mesmo naipe (4♣ 5♣ 6♣). O Ás vale A-2-3 ou Q-K-A, mas não dá a volta (K-A-2 não vale).' })),
            el('h4', { text: 'Curinga' }),
            p('A carta virada na mesa (a "vira") define o curinga: é o valor logo acima dela. Virou 7? Todos os 8 são curingas e valem qualquer carta. Eles aparecem com borda dourada e ★.'),
            el('h4', { text: 'Sua vez' }),
            el('ul', {}, el('li', { text: '1º: compre uma carta do Monte (fechada) ou do Lixo (a de cima, aberta).' }),
                el('li', { text: '2º: descarte uma carta no Lixo (você volta a ter 9). Você não pode descartar a carta que acabou de pegar do Lixo.' })),
            el('h4', { text: 'Bater (ganhar a rodada)' }),
            p('Depois de comprar você tem 10 cartas. Se 9 delas formam os 3 jogos, toque em BATER! A 10ª carta sobrando é o seu descarte (ela ganha um contorno tracejado).'),
            el('h4', { text: 'Dicas' }),
            el('ul', {}, el('li', { text: 'As faixas coloridas na base das cartas mostram os jogos que você já tem.' }),
                el('li', { text: '🪄 Ordenar junta seus jogos à esquerda. Arraste para reorganizar ou até o Lixo para descartar.' }),
                el('li', { text: 'Conta: com conta suas vitórias ficam salvas. Como convidado, valem só nesta sessão.' })),
            el('div', { class: 'actions' }, el('button', { class: 'btn primary', type: 'button', on: { click: () => closeModal() } }, 'Entendi')),
        ], { cls: 'help' });
    }

    function showGameOver(d) {
        const mine = game && d.winnerPid === game.me.pid;
        sfx('win');
        confetti();
        closeModal();
        $('winner-msg').textContent = mine ? '🎉 VOCÊ BATEU! 🎉' : `🎉 ${d.winnerAvatar} ${d.winnerName} BATEU! 🎉`;
        const sets = d.sets.map((st) => el('div', { class: 'set-group' }, st.map((c) => cardNode(c, { wild: c.value === d.wildcardValue }))));
        if (d.discard) sets.push(el('div', { class: 'set-group', style: 'margin-left:30px;opacity:.7' }, el('div', {}, el('small', { text: 'Descarte:' }), el('br'), cardNode(d.discard))));
        $('winner-hand').replaceChildren(...sets);
        $('over-scoreboard').replaceChildren(...d.scoreboard.map((r) => el('tr', {}, el('td', { text: `${r.avatar} ${r.name}` }), el('td', { text: `🏆 ${r.wins}` }))));
        $('game-over-screen').classList.add('active');
    }
    const hideGameOver = () => $('game-over-screen').classList.remove('active');

    /* ====================================================================== */
    /*  EVENTOS DO SOCKET                                                      */
    /* ====================================================================== */
    socket.on('connect', () => { hideToast(); resumeSession(); });
    socket.on('disconnect', () => toast('📶 Conexão perdida. Reconectando…', 0));
    socket.on('room_list', renderRooms);

    socket.on('joined', ({ roomId }) => {
        joinSeq += 1;
        if (lastRoomId !== roomId) { $('chat-messages').replaceChildren(); lastRoomId = roomId; selectedId = null; localHand = []; game = null; }
        closeModal();
        show('game');
    });
    socket.on('left_table', () => toLobby());
    socket.on('kicked_by_admin', () => toLobby('Você foi expulso(a) da sala pelo administrador.'));
    socket.on('session_replaced', () => toLobby('Sua conta entrou em outro aparelho, então esta tela saiu da mesa.'));
    socket.on('gameState', handleState);
    socket.on('game_started', () => { hideGameOver(); toast('🎲 A partida começou! Veja o curinga no centro da mesa.', 3000); });
    socket.on('alerta', (msg) => toast(String(msg)));
    socket.on('play_sound', sfx);
    socket.on('gameOver', showGameOver);

    socket.on('chat_message', (d) => {
        const mine = game && d.pid === game.me.pid;
        pushChat(el('div', { class: `chat-msg${mine ? ' mine' : ''}` }, el('b', { text: `${d.avatar || ''} ${d.sender}: ` }), d.text), !mine);
    });
    socket.on('chat_system', (msg) => pushChat(el('div', { class: 'chat-msg system', text: String(msg) }), false));

    socket.on('receive_emote', ({ pid, emote }) => {
        sfx('pop');
        const origin = (game && game.me.pid === pid) ? $('player-name') : document.querySelector(`[data-pid="${CSS.escape(String(pid))}"]`);
        const node = el('div', { class: 'floating-emote', text: String(emote) });
        const r = origin ? origin.getBoundingClientRect() : null;
        node.style.left = r ? `${r.left + r.width / 2}px` : '50%';
        node.style.top = r ? `${r.top + 10}px` : '40%';
        document.body.append(node);
        setTimeout(() => node.remove(), 2500);
    });

    /* ====================================================================== */
    /*  LIGAÇÕES DE INTERFACE                                                  */
    /* ====================================================================== */
    function buildReactBar() {
        $('reactbar').replaceChildren(...EMOTES.map((em) => el('button', {
            class: 'react', type: 'button', 'aria-label': `Reagir com ${em}`,
            on: { click: (e) => {
                const btn = e.currentTarget;
                socket.emit('send_emote', em);
                btn.classList.add('cool');                       // evita spam sem travar a barra toda
                setTimeout(() => btn.classList.remove('cool'), 900);
            } },
        }, em)));
    }

    function bindUI() {
        buildReactBar();
        $('form-join').addEventListener('submit', (e) => { e.preventDefault(); joinRoom($('join-room').value.toUpperCase(), $('join-pass').value); });
        $('btn-logout').addEventListener('click', doLogout);
        $('btn-upgrade').addEventListener('click', () => {
            upgradeMode = true;
            document.querySelector('.tabs').hidden = true;
            $('btn-auth-back').hidden = false;
            show('auth'); setTab('signup');
        });
        document.querySelectorAll('[data-help]').forEach((b) => b.addEventListener('click', openHelp));
        $('btn-help').addEventListener('click', openHelp);
        $('btn-toggle-chat').addEventListener('click', () => setChat(!chatOpen));
        $('btn-theme').addEventListener('click', (e) => { e.stopPropagation(); $('theme-menu').classList.toggle('show'); });
        document.querySelectorAll('.theme-opt').forEach((b) => b.addEventListener('click', () => { setTheme(b.dataset.theme); $('theme-menu').classList.remove('show'); }));
        document.addEventListener('click', (e) => { if (!e.target.closest('.emote-wrapper')) $('theme-menu').classList.remove('show'); });
        $('btn-sound').addEventListener('click', () => { muted = !muted; ls.set('pife_mute', muted ? '1' : '0'); updateSoundBtn(); });
        $('btn-start').addEventListener('click', () => socket.emit('startGame'));
        $('btn-reset').addEventListener('click', async () => {
            if (await confirmDialog('Resetar a mesa cancela a partida de todos. Continuar?', { yes: 'Resetar', danger: true })) socket.emit('resetGame');
        });
        $('btn-leave').addEventListener('click', async () => {
            if (await confirmDialog('Levantar da mesa e voltar ao saguão?', { yes: 'Sair da mesa', danger: true })) socket.emit('leave_table');
        });
        document.querySelectorAll('.layout-btn').forEach((b) => b.addEventListener('click', () => { layout = b.dataset.layout; ls.set('pife_layout', layout); if (game) renderHand(); renderActions(); }));
        $('btn-new-round').addEventListener('click', hideGameOver);
        updateSoundBtn();
        $('btn-close-chat').addEventListener('click', () => setChat(false));
        $('chat-input-area').addEventListener('submit', (e) => {
            e.preventDefault();
            const input = $('chat-input');
            if (input.value.trim()) socket.emit('send_chat', input.value);
            input.value = '';
        });

        const drawFrom = (event) => () => {
            if (!canDraw()) return toast(whyNotDraw());
            socket.emit(event);
        };
        const bindPile = (id, event) => {
            const node = $(id);
            const go = drawFrom(event);
            node.addEventListener('click', go);
            node.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
        };
        bindPile('pile-deck', 'draw_deck');
        bindPile('pile-discard', 'draw_discard');

        $('btn-sort').addEventListener('click', autoSort);
        $('btn-discard').addEventListener('click', () => {
            if (!selectedId) return toast(myTurn() && game.phase === 'discard' ? 'Toque numa carta da sua mão para escolher qual descartar.' : whyNotDraw() || 'Compre uma carta primeiro.');
            tryDiscard(selectedId);
        });
        $('btn-bater').addEventListener('click', () => {
            if (!canDiscard()) return toast(myTurn() ? 'Para bater, primeiro compre uma carta (Monte ou Lixo).' : 'Você só pode bater na sua vez, depois de comprar.');
            socket.emit('bater');
        });

        const hand = $('my-hand');
        hand.addEventListener('pointerdown', onHandPointerDown);
        hand.addEventListener('contextmenu', (e) => e.preventDefault());
        hand.addEventListener('keydown', (e) => {
            const card = e.target.closest && e.target.closest('.card');
            if (card && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggleSelect(card.dataset.id); }
        });

        document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (modalClose) closeModal(); else if (chatOpen) setChat(false); } });
        document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') cancelDrag(); });
        window.addEventListener('blur', cancelDrag);
        window.addEventListener('resize', () => { if (game && screen === 'game' && !drag) renderHand(); });
        setInterval(updateCountdowns, 1000);
    }

    /* ---------- início ---------- */
    setTheme(THEMES[ls.get('pife_theme')] ? ls.get('pife_theme') : 'green');
    buildAvatarPickers();
    bindAuthForms();
    bindUI();
    setTab('guest');
    setTimeout(() => { if (screen === 'splash') { show('auth'); setTab('guest'); } }, 10000);
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
})();
