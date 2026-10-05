'use strict';
/*
 * Servidor do jogo (salas, turnos, contas, vitórias), independente do transporte.
 * Recebe um objeto `io` com a mesma interface do socket.io, o que permite testar tudo sem rede.
 *
 * Identidade:
 *  - CONTA  -> chave "u:<usuario>"  (autenticada por token; vitórias salvas no Store)
 *  - CONVIDADO -> chave "g:<guestId>" (guestId secreto, vive só na aba; vitórias só em memória
 *                 e apagadas quando a pessoa sai ou a sessão expira)
 * A chave NUNCA é enviada a outros jogadores (antes o sessionId vazava e dava para sequestrar contas).
 * Para identificar jogadores entre si usa-se o `pid`, um id público e aleatório por assento.
 */
const crypto = require('crypto');
const Rules = require('../public/rules.js');

const AVATARS = ['🤠', '👽', '🤖', '🦊', '😎', '🤡'];
const EMOTES = ['😂', '😡', '🍻', '💔', '😎', '😭', '👏', '🤔'];
const MAX_PLAYERS = 4;
const GUEST_ID_RE = /^[a-f0-9]{16,64}$/;
const GUEST_TTL_MS = 6 * 60 * 60 * 1000;

const cleanText = (s, max) =>
    typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max) : '';
const cleanName = (s, max) => cleanText(s, max * 2).replace(/[<>&"'`\\]/g, '').trim().slice(0, max);

const hashPass = async (pass) => {
    const salt = crypto.randomBytes(16);
    const hash = await new Promise((res, rej) => crypto.scrypt(pass, salt, 32, (e, k) => (e ? rej(e) : res(k))));
    return { salt, hash };
};
const verifyPass = async (pass, rec) => {
    const hash = await new Promise((res, rej) => crypto.scrypt(pass, rec.salt, 32, (e, k) => (e ? rej(e) : res(k))));
    return crypto.timingSafeEqual(hash, rec.hash);
};

function createHub({ io, store, reconnectMs = 60000, randInt = (n) => crypto.randomInt(n) }) {
    const rooms = new Map();
    const guests = new Map();   // guestId -> { wins, lastSeen }
    const authHits = new Map(); // ip -> [timestamps]
    let sweeper = null;

    /* ---------- utilidades ---------- */

    const roomList = () => [...rooms.values()].map((r) => ({
        id: r.id, count: r.players.length, hasPassword: !!r.pass, playing: r.status === 'playing',
    }));
    const emitRoomList = () => io.emit('room_list', roomList());

    function allow(socket, bucket, max, ms) {
        const limits = (socket.data.limits = socket.data.limits || {});
        const now = Date.now();
        const hits = (limits[bucket] || []).filter((t) => now - t < ms);
        if (hits.length >= max) { limits[bucket] = hits; return false; }
        hits.push(now);
        limits[bucket] = hits;
        return true;
    }

    function authAllowed(ip) {
        const now = Date.now();
        const hits = (authHits.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
        if (hits.length >= 20) { authHits.set(ip, hits); return false; }
        hits.push(now);
        authHits.set(ip, hits);
        return true;
    }

    const ipOf = (socket) => {
        const xf = socket.handshake && socket.handshake.headers && socket.handshake.headers['x-forwarded-for'];
        if (typeof xf === 'string' && xf) return xf.split(',')[0].trim();
        return (socket.handshake && socket.handshake.address) || '?';
    };

    /* ---------- vitórias ---------- */

    function winsOf(key) {
        if (key.startsWith('u:')) return store.getWins(key.slice(2));
        const g = guests.get(key.slice(2));
        return g ? g.wins : 0;
    }

    function addWin(key) {
        if (key.startsWith('u:')) { store.addWin(key.slice(2)); return; }
        const id = key.slice(2);
        const g = guests.get(id) || { wins: 0, lastSeen: 0 };
        g.wins += 1;
        g.lastSeen = Date.now();
        guests.set(id, g);
    }

    function sweepGuests() {
        const now = Date.now();
        const seated = new Set();
        rooms.forEach((r) => r.players.forEach((p) => seated.add(p.key)));
        for (const [id, g] of guests) {
            if (!seated.has(`g:${id}`) && now - g.lastSeen > GUEST_TTL_MS) guests.delete(id);
        }
    }

    /* ---------- estado enviado aos clientes ---------- */

    const isPaused = (room) => room.status === 'playing' && room.players.some((p) => !p.connected);

    function stateFor(room, me) {
        const playing = room.status === 'playing';
        const cur = playing ? room.players[room.turnIndex] : null;
        return {
            roomId: room.id,
            status: room.status,
            paused: isPaused(room),
            deckCount: room.deck.length,
            discardTop: room.discardPile.length ? room.discardPile[room.discardPile.length - 1] : null,
            discardCount: room.discardPile.length,
            wildcardCard: room.wildcardCard,
            wildcardValue: room.wildcardValue,
            turnPid: cur ? cur.pid : null,
            phase: cur ? (cur.hasDrawn ? 'discard' : 'draw') : null,
            isAdmin: room.adminKey === me.key,
            players: room.players.map((q) => ({
                pid: q.pid,
                name: q.name,
                avatar: q.avatar,
                wins: winsOf(q.key),
                cards: q.hand.length,
                connected: q.connected,
                isAdmin: room.adminKey === q.key,
                isMe: q === me,
                reconnectAt: q.reconnectAt,
            })),
            me: {
                pid: me.pid,
                name: me.name,
                avatar: me.avatar,
                wins: winsOf(me.key),
                hand: me.hand,
                hasDrawn: me.hasDrawn,
                lockedDiscardId: me.drewFromDiscard,
            },
        };
    }

    function sendTo(player, event, payload) {
        const s = player.socketId && io.sockets.sockets.get(player.socketId);
        if (s) s.emit(event, payload);
    }

    function updateClients(room) {
        room.players.forEach((p) => { if (p.connected) sendTo(p, 'gameState', stateFor(room, p)); });
    }

    const say = (room, text) => io.to(room.chan).emit('chat_system', text);

    /* ---------- salas e jogadores ---------- */

    function findSeat(key) {
        for (const room of rooms.values()) {
            const player = room.players.find((p) => p.key === key);
            if (player) return { room, player };
        }
        return null;
    }

    function resetRound(room) {
        room.status = 'waiting';
        room.deck = [];
        room.discardPile = [];
        room.wildcardCard = null;
        room.wildcardValue = null;
        room.turnIndex = 0;
        room.players.forEach((p) => { p.hand = []; p.hasDrawn = false; p.drewFromDiscard = null; });
    }

    function advanceTurn(room) {
        room.turnIndex = (room.turnIndex + 1) % room.players.length;
        const next = room.players[room.turnIndex];
        next.hasDrawn = false;
        next.drewFromDiscard = null;
    }

    function seatSocket(socket, room, player) {
        const oldId = player.socketId;
        if (oldId && oldId !== socket.id) {
            const old = io.sockets.sockets.get(oldId);
            if (old) {
                old.data.roomId = null;
                old.leave(room.chan);
                old.emit('session_replaced');
            }
        }
        clearTimeout(room.timers.get(player.key));
        room.timers.delete(player.key);
        player.socketId = socket.id;
        player.connected = true;
        player.reconnectAt = null;
        socket.join(room.chan);
        socket.data.roomId = room.id;
        socket.emit('joined', { roomId: room.id });
    }

    /** Remove o jogador da mesa. Se a partida está em andamento e sobram 2+, ela continua. */
    function removePlayer(room, key, reason) {
        const idx = room.players.findIndex((p) => p.key === key);
        if (idx < 0) return;
        const [p] = room.players.splice(idx, 1);
        clearTimeout(room.timers.get(key));
        room.timers.delete(key);

        const sock = p.socketId && io.sockets.sockets.get(p.socketId);
        if (sock && sock.data.roomId === room.id) {
            sock.leave(room.chan);
            sock.data.roomId = null;
        }

        if (room.adminKey === key) {
            const next = room.players.find((x) => x.connected) || room.players[0];
            room.adminKey = next ? next.key : null;
        }

        if (room.players.length === 0) {
            rooms.delete(room.id);
            emitRoomList();
            return;
        }

        const why = { left: 'levantou da mesa', kicked: 'foi expulso(a)', timeout: 'caiu e não voltou a tempo', moved: 'foi para outra sala' }[reason] || 'saiu';
        say(room, `🔴 ${p.avatar} ${p.name} ${why}.`);

        if (room.status === 'playing') {
            if (room.players.length < 2) {
                resetRound(room);
                say(room, '⚠️ Sobrou só um jogador: a partida foi cancelada.');
            } else {
                room.deck.unshift(...p.hand); // as cartas dele voltam para o fundo do monte
                if (idx < room.turnIndex) {
                    room.turnIndex -= 1;
                } else if (idx === room.turnIndex) {
                    if (room.turnIndex >= room.players.length) room.turnIndex = 0;
                    const cur = room.players[room.turnIndex];
                    cur.hasDrawn = false;
                    cur.drewFromDiscard = null;
                }
                say(room, '▶️ A partida continua com os jogadores restantes.');
            }
        }
        updateClients(room);
        emitRoomList();
    }

    /* ---------- contexto de cada evento ---------- */

    function ctx(socket) {
        const ident = socket.data.identity;
        const room = socket.data.roomId && rooms.get(socket.data.roomId);
        if (!ident || !room) return null;
        const player = room.players.find((p) => p.key === ident.key && p.socketId === socket.id);
        return player ? { ident, room, player } : null;
    }

    function turnCtx(socket) {
        const c = ctx(socket);
        if (!c) return null;
        const { room, player } = c;
        if (room.status !== 'playing') { socket.emit('alerta', 'A partida ainda não começou.'); return null; }
        if (isPaused(room)) { socket.emit('alerta', 'Jogo pausado: um jogador caiu. Aguarde ele voltar.'); return null; }
        if (room.players[room.turnIndex] !== player) { socket.emit('alerta', 'Ainda não é a sua vez.'); return null; }
        return c;
    }

    /* ---------- conexão ---------- */

    function onConnection(socket) {
        socket.data = socket.data || {};
        socket.emit('room_list', roomList());

        const on = (event, fn) => socket.on(event, async (...args) => {
            try { await fn(...args); } catch (err) { console.error(`[${event}]`, err); }
        });
        const replier = (ack) => (typeof ack === 'function' ? ack : () => {});

        /* ----- autenticação ----- */
        on('auth', async (payload, ack) => {
            const reply = replier(ack);
            if (!payload || typeof payload !== 'object') return reply({ ok: false, error: 'Pedido inválido.' });
            const mode = payload.mode;
            let ident = null;
            let token = null;
            let profile = null;

            if (mode === 'login' || mode === 'signup') {
                if (!authAllowed(ipOf(socket))) return reply({ ok: false, error: 'Muitas tentativas. Aguarde alguns minutos.' });
                const avatar = AVATARS.includes(payload.avatar) ? payload.avatar : AVATARS[0];
                const res = mode === 'signup'
                    ? await store.signup(payload.username, payload.password, avatar)
                    : await store.login(payload.username, payload.password);
                if (!res.ok) return reply({ ok: false, error: res.error });
                if (mode === 'signup' && typeof payload.guestId === 'string' && guests.has(payload.guestId)) {
                    // quem era convidado e cria conta leva as vitórias da sessão junto
                    const carried = guests.get(payload.guestId).wins;
                    if (carried > 0) store.addWins(res.user.name.toLowerCase(), carried);
                    guests.delete(payload.guestId);
                    res.user.wins += carried;
                }
                token = res.token;
                profile = res.user;
                ident = { type: 'user', key: `u:${res.user.name.toLowerCase()}`, name: res.user.name, avatar: res.user.avatar };
            } else if (mode === 'token') {
                const res = store.resume(payload.token);
                if (!res.ok) return reply({ ok: false, error: 'Sessão expirada. Entre novamente.', expired: true });
                profile = res.user;
                ident = { type: 'user', key: `u:${res.user.name.toLowerCase()}`, name: res.user.name, avatar: res.user.avatar };
            } else if (mode === 'guest') {
                const guestId = payload.guestId;
                const nick = cleanName(payload.nick, 16);
                if (typeof guestId !== 'string' || !GUEST_ID_RE.test(guestId)) return reply({ ok: false, error: 'Sessão de convidado inválida.' });
                if (nick.length < 2) return reply({ ok: false, error: 'Escolha um apelido com pelo menos 2 caracteres.' });
                if (store.isNameTaken(nick)) return reply({ ok: false, error: 'Esse apelido pertence a uma conta registrada. Escolha outro ou entre na sua conta.' });
                const avatar = AVATARS.includes(payload.avatar) ? payload.avatar : AVATARS[0];
                const g = guests.get(guestId) || { wins: 0, lastSeen: 0 };
                g.lastSeen = Date.now();
                guests.set(guestId, g);
                ident = { type: 'guest', key: `g:${guestId}`, name: nick, avatar };
                profile = { name: nick, avatar, wins: g.wins };
            } else {
                return reply({ ok: false, error: 'Pedido inválido.' });
            }

            // trocou de identidade com o socket sentado numa mesa? sai da mesa antiga
            const previous = socket.data.identity;
            if (previous && previous.key !== ident.key) {
                const seat = ctx(socket);
                if (seat) removePlayer(seat.room, previous.key, 'left');
            }
            socket.data.identity = ident;
            reply({ ok: true, profile: { type: ident.type, name: ident.name, avatar: ident.avatar, wins: winsOf(ident.key) }, token });

            // já estava sentado numa mesa (queda de conexão, outro aparelho...)? volta direto para ela
            const seat = findSeat(ident.key);
            if (seat) {
                const wasOffline = !seat.player.connected;
                seat.player.name = ident.name;
                seat.player.avatar = ident.avatar;
                seatSocket(socket, seat.room, seat.player);
                if (wasOffline) say(seat.room, `✅ ${seat.player.avatar} ${seat.player.name} reconectou!`);
                updateClients(seat.room);
            }
        });

        on('logout', (payload, ack) => {
            const reply = replier(ack);
            const ident = socket.data.identity;
            if (!ident) return reply({ ok: true });
            const seat = ctx(socket);
            if (seat) removePlayer(seat.room, ident.key, 'left');
            if (ident.type === 'guest') guests.delete(ident.key.slice(2)); // convidado: some com as estatísticas
            else if (payload && typeof payload.token === 'string') store.logout(payload.token);
            socket.data.identity = null;
            reply({ ok: true });
        });

        /* ----- salas ----- */
        on('join_room', async (data, ack) => {
            const reply = replier(ack);
            const ident = socket.data.identity;
            if (!ident) return reply({ ok: false, error: 'Entre com sua conta ou como convidado primeiro.' });
            if (!allow(socket, 'join', 8, 10000)) return reply({ ok: false, error: 'Calma! Tente de novo em instantes.' });

            const roomId = cleanName(data && data.room, 20).toUpperCase() || 'MESA1';
            const password = data && typeof data.password === 'string' ? data.password.slice(0, 64) : '';

            let room = rooms.get(roomId);
            const alreadySeated = !!(room && room.players.some((p) => p.key === ident.key));
            let verified = false;
            if (room && room.pass && !alreadySeated) {
                if (!(await verifyPass(password, room.pass))) return reply({ ok: false, error: 'Senha incorreta para esta sala.' });
                verified = true;
            }
            const newPass = !room && password ? await hashPass(password) : null;

            // --- a partir daqui é tudo síncrono (sem corridas entre jogadores) ---
            room = rooms.get(roomId);
            if (room) {
                const seated = room.players.find((p) => p.key === ident.key);
                if (!seated) {
                    if (room.pass && !verified) return reply({ ok: false, error: 'Tente entrar novamente.' });
                    if (room.players.length >= MAX_PLAYERS) return reply({ ok: false, error: `A mesa está cheia (máximo ${MAX_PLAYERS}).` });
                    if (room.status === 'playing') return reply({ ok: false, error: 'Partida em andamento. Aguarde a rodada acabar.' });
                    if (room.players.some((p) => p.name.toLowerCase() === ident.name.toLowerCase())) {
                        return reply({ ok: false, error: 'Já existe alguém com esse nome nesta sala.' });
                    }
                }
            }

            const other = findSeat(ident.key);
            if (other && other.room.id !== roomId) removePlayer(other.room, ident.key, 'moved');

            let player;
            if (!room) {
                room = {
                    id: roomId, chan: `room:${roomId}`, pass: newPass, adminKey: ident.key, status: 'waiting', players: [],
                    deck: [], discardPile: [], wildcardCard: null, wildcardValue: null,
                    turnIndex: 0, starterIndex: 0, timers: new Map(),
                };
                rooms.set(roomId, room);
            }
            player = room.players.find((p) => p.key === ident.key);
            const isNew = !player;
            if (isNew) {
                player = {
                    key: ident.key, pid: crypto.randomBytes(6).toString('hex'), name: ident.name, avatar: ident.avatar,
                    socketId: null, connected: false, reconnectAt: null, hand: [], hasDrawn: false, drewFromDiscard: null,
                };
                room.players.push(player);
            }
            player.name = ident.name;
            player.avatar = ident.avatar;
            seatSocket(socket, room, player);
            if (isNew) say(room, `🟢 ${player.avatar} ${player.name} entrou na sala.`);
            reply({ ok: true, roomId });
            updateClients(room);
            emitRoomList();
        });

        on('leave_table', () => {
            const c = ctx(socket);
            if (c) removePlayer(c.room, c.ident.key, 'left');
            socket.emit('left_table');
        });

        on('kick_player', (pid) => {
            const c = ctx(socket);
            if (!c || typeof pid !== 'string') return;
            if (c.room.adminKey !== c.player.key) return socket.emit('alerta', 'Só o administrador pode expulsar jogadores.');
            const target = c.room.players.find((p) => p.pid === pid);
            if (!target || target === c.player) return;
            sendTo(target, 'kicked_by_admin');
            removePlayer(c.room, target.key, 'kicked');
        });

        /* ----- chat e reações ----- */
        on('send_chat', (msg) => {
            const c = ctx(socket);
            if (!c) return;
            if (!allow(socket, 'chat', 5, 5000)) return socket.emit('alerta', 'Devagar com as mensagens!');
            const text = cleanText(msg, 200);
            if (text) io.to(c.room.chan).emit('chat_message', { pid: c.player.pid, sender: c.player.name, avatar: c.player.avatar, text });
        });

        on('send_emote', (emote) => {
            const c = ctx(socket);
            if (!c || !EMOTES.includes(emote)) return;
            if (!allow(socket, 'emote', 4, 4000)) return;
            io.to(c.room.chan).emit('receive_emote', { pid: c.player.pid, emote });
        });

        /* ----- partida ----- */
        on('startGame', () => {
            const c = ctx(socket);
            if (!c) return;
            const { room, player } = c;
            if (room.adminKey !== player.key) return socket.emit('alerta', 'Só o administrador da mesa pode iniciar a partida.');
            if (room.status === 'playing') return;
            if (room.players.length < 2) return socket.emit('alerta', 'São necessários pelo menos 2 jogadores.');
            if (room.players.some((p) => !p.connected)) return socket.emit('alerta', 'Aguarde todos reconectarem ou expulse quem caiu.');

            room.deck = Rules.createDeck(randInt);
            room.wildcardCard = room.deck.pop();
            room.wildcardValue = Rules.nextValue(room.wildcardCard.value);
            room.discardPile = [room.deck.pop()];
            room.players.forEach((p) => {
                p.hand = room.deck.splice(0, 9);
                p.hasDrawn = false;
                p.drewFromDiscard = null;
            });
            room.turnIndex = room.starterIndex % room.players.length;
            room.starterIndex += 1;
            room.status = 'playing';
            say(room, `🎲 A partida começou! O curinga é o ${room.wildcardValue}. Quem começa: ${room.players[room.turnIndex].name}.`);
            io.to(room.chan).emit('game_started');
            updateClients(room);
            emitRoomList();
        });

        on('draw_deck', () => {
            const c = turnCtx(socket);
            if (!c) return;
            const { room, player } = c;
            if (player.hasDrawn) return socket.emit('alerta', 'Você já comprou nesta rodada: agora descarte uma carta.');
            if (room.deck.length === 0 && room.discardPile.length > 1) {
                const top = room.discardPile.pop();
                room.deck = Rules.shuffle(room.discardPile, randInt);
                room.discardPile = [top];
                say(room, '♻️ O monte acabou: o lixo foi embaralhado e virou o novo monte.');
            }
            if (room.deck.length === 0) return socket.emit('alerta', 'Não há cartas no monte. Compre a carta do Lixo.');
            player.hand.push(room.deck.pop());
            player.hasDrawn = true;
            player.drewFromDiscard = null;
            socket.emit('play_sound', 'draw');
            updateClients(room);
        });

        on('draw_discard', () => {
            const c = turnCtx(socket);
            if (!c) return;
            const { room, player } = c;
            if (player.hasDrawn) return socket.emit('alerta', 'Você já comprou nesta rodada: agora descarte uma carta.');
            if (room.discardPile.length === 0) return socket.emit('alerta', 'O lixo está vazio.');
            const card = room.discardPile.pop();
            player.hand.push(card);
            player.hasDrawn = true;
            player.drewFromDiscard = card.id;
            say(room, `📜 ${player.avatar} ${player.name} pegou do lixo: ${card.value}${card.suit}.`);
            socket.emit('play_sound', 'draw');
            updateClients(room);
        });

        on('discard', (cardId) => {
            const c = turnCtx(socket);
            if (!c || typeof cardId !== 'string') return;
            const { room, player } = c;
            if (!player.hasDrawn) return socket.emit('alerta', 'Compre uma carta antes de descartar.');
            if (cardId === player.drewFromDiscard) {
                return socket.emit('alerta', 'Você acabou de pegar essa carta do Lixo. Descarte outra.');
            }
            const idx = player.hand.findIndex((card) => card.id === cardId);
            if (idx < 0) return;
            room.discardPile.push(player.hand.splice(idx, 1)[0]);
            advanceTurn(room);
            socket.emit('play_sound', 'discard');
            updateClients(room);
        });

        on('bater', () => {
            const c = turnCtx(socket);
            if (!c) return;
            const { room, player } = c;
            if (!player.hasDrawn || player.hand.length !== 10) {
                return socket.emit('alerta', 'Para bater, primeiro compre uma carta (Monte ou Lixo).');
            }
            const result = Rules.validateWin(player.hand, room.wildcardValue);
            if (!result) {
                const m = Rules.bestMelds(player.hand, room.wildcardValue);
                return socket.emit('alerta',
                    `Ainda não dá para bater: você tem ${m.count} de 3 jogos prontos. ` +
                    'Para bater, 9 das suas 10 cartas precisam formar 3 jogos de 3 (trincas ou sequências); a 10ª é o descarte.');
            }
            addWin(player.key);
            const scoreboard = room.players
                .map((p) => ({ name: p.name, avatar: p.avatar, wins: winsOf(p.key) }))
                .sort((a, b) => b.wins - a.wins);
            io.to(room.chan).emit('gameOver', {
                winnerPid: player.pid,
                winnerName: player.name,
                winnerAvatar: player.avatar,
                sets: result.sets,
                discard: result.discard,
                wildcardValue: room.wildcardValue,
                scoreboard,
            });
            say(room, `🏆 ${player.avatar} ${player.name} BATEU e ganhou a rodada!`);
            resetRound(room);
            updateClients(room);
        });

        on('resetGame', () => {
            const c = ctx(socket);
            if (!c) return;
            if (c.room.adminKey !== c.player.key) return socket.emit('alerta', 'Só o administrador pode resetar a mesa.');
            resetRound(c.room);
            say(c.room, `⚠️ A mesa foi resetada por ${c.player.name}.`);
            updateClients(c.room);
            emitRoomList();
        });

        /* ----- queda de conexão ----- */
        socket.on('disconnect', () => {
            const ident = socket.data.identity;
            const room = socket.data.roomId && rooms.get(socket.data.roomId);
            if (ident && ident.type === 'guest') {
                const g = guests.get(ident.key.slice(2));
                if (g) g.lastSeen = Date.now();
            }
            if (!ident || !room) return;
            const player = room.players.find((p) => p.key === ident.key && p.socketId === socket.id);
            if (!player) return;
            player.connected = false;
            player.reconnectAt = Date.now() + reconnectMs;
            say(room, `⚠️ ${player.avatar} ${player.name} desconectou. A mesa espera ${Math.round(reconnectMs / 1000)}s pela volta dele(a).`);
            const timer = setTimeout(() => removePlayer(room, player.key, 'timeout'), reconnectMs);
            if (timer.unref) timer.unref();
            room.timers.set(player.key, timer);
            updateClients(room);
        });
    }

    function startSweeper() {
        sweeper = setInterval(sweepGuests, 10 * 60 * 1000);
        if (sweeper.unref) sweeper.unref();
    }

    function shutdown() {
        clearInterval(sweeper);
        rooms.forEach((r) => r.timers.forEach((t) => clearTimeout(t)));
    }

    return { onConnection, rooms, guests, winsOf, sweepGuests, startSweeper, shutdown };
}

module.exports = { createHub, AVATARS, EMOTES };
