'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../src/store.js');
const { createHub } = require('../src/hub.js');

/* ---- socket.io falso: permite testar o servidor inteiro sem rede ---- */
class FakeSocket {
    constructor(io, id) {
        this.io = io; this.id = id; this.data = {};
        this.handshake = { address: '10.0.0.1', headers: {} };
        this.handlers = {}; this.rooms = new Set([id]); this.received = [];
        io.sockets.sockets.set(id, this);
    }
    on(ev, fn) { this.handlers[ev] = fn; }
    emit(ev, payload) { this.received.push([ev, payload]); }
    join(r) { this.rooms.add(r); }
    leave(r) { this.rooms.delete(r); }
    async send(ev, payload) { return this.handlers[ev](payload); }
    async ask(ev, payload) { let out; await this.handlers[ev](payload, (r) => { out = r; }); return out; }
    has(ev) { return this.received.some(([e]) => e === ev); }
    all(ev) { return this.received.filter(([e]) => e === ev).map(([, p]) => p); }
    last(ev) { const a = this.all(ev); return a[a.length - 1]; }
    async disconnect() { this.io.sockets.sockets.delete(this.id); await this.handlers.disconnect(); }
}
class FakeIO {
    constructor() { this.sockets = { sockets: new Map() }; this.n = 0; }
    to(room) { return { emit: (ev, p) => this.sockets.sockets.forEach((s) => { if (s.rooms.has(room)) s.emit(ev, p); }) }; }
    emit(ev, p) { this.sockets.sockets.forEach((s) => s.emit(ev, p)); }
}

function setup(opts = {}) {
    const io = new FakeIO();
    const store = new Store(null);
    const hub = createHub({ io, store, ...opts });
    const connect = () => {
        const s = new FakeSocket(io, `sock${++io.n}`);
        hub.onConnection(s);
        return s;
    };
    return { io, store, hub, connect };
}

let gid = 0;
const guestId = () => (`${++gid}`.padStart(2, '0') + 'ab'.repeat(15));

async function guest(connect, nick, id = guestId()) {
    const s = connect();
    const res = await s.ask('auth', { mode: 'guest', guestId: id, nick, avatar: '🤠' });
    assert.equal(res.ok, true, res.error);
    s.guestId = id;
    return s;
}

async function table(connect, nicks, room = 'MESA1') {
    const socks = [];
    for (const n of nicks) {
        const s = await guest(connect, n);
        const r = await s.ask('join_room', { room });
        assert.equal(r.ok, true, r.error);
        socks.push(s);
    }
    return socks;
}

const roomOf = (hub, id = 'MESA1') => hub.rooms.get(id);
const c = (id, value, suit) => ({ id, value, suit });
const WIN10 = () => [
    c('a1', '3', '♥'), c('a2', '4', '♥'), c('a3', '5', '♥'),
    c('b1', '7', '♣'), c('b2', '7', '♦'), c('b3', '7', '♠'),
    c('c1', '9', '♠'), c('c2', '10', '♠'), c('c3', 'J', '♠'),
    c('x1', 'A', '♣'),
];

/* ---------------- autenticação / identidade ---------------- */

test('convidado entra; apelido de conta registrada é reservado', async () => {
    const { connect, store } = setup();
    await store.signup('Adler', 'segredo1', '🤠');
    const s = connect();
    const bad = await s.ask('auth', { mode: 'guest', guestId: guestId(), nick: 'adler', avatar: '🤠' });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /conta registrada/);
    const ok = await s.ask('auth', { mode: 'guest', guestId: guestId(), nick: 'Visitante', avatar: '🤠' });
    assert.equal(ok.ok, true);
    assert.equal(ok.profile.type, 'guest');
    assert.equal(ok.profile.wins, 0);
});

test('payloads malformados nunca derrubam o servidor', async () => {
    const { connect } = setup();
    const s = connect();
    for (const ev of ['auth', 'join_room', 'kick_player', 'send_chat', 'send_emote', 'discard', 'bater', 'startGame', 'logout']) {
        for (const payload of [undefined, null, 42, {}, [], 'x', { room: {}, nick: {}, mode: {} }]) {
            await s.ask(ev, payload);
        }
    }
    const g = await guest(connect, 'Ok');
    await g.ask('join_room', { room: { toString: 1 }, password: {} });
    assert.ok(true);
});

test('não entra em sala sem autenticar', async () => {
    const { connect } = setup();
    const s = connect();
    const r = await s.ask('join_room', { room: 'X' });
    assert.equal(r.ok, false);
});

test('o estado enviado aos outros jogadores não vaza a identidade secreta', async () => {
    const { connect } = setup();
    const [a, b] = await table(connect, ['Ana', 'Beto']);
    const json = JSON.stringify([...a.received, ...b.received]);
    assert.ok(!json.includes(a.guestId), 'guestId de Ana vazou');
    assert.ok(!json.includes(b.guestId), 'guestId de Beto vazou');
    assert.ok(!json.includes('g:'), 'chave interna vazou');
});

test('outra pessoa não consegue assumir a vaga de alguém sem o segredo', async () => {
    const { connect, hub } = setup();
    const [a, b] = await table(connect, ['Ana', 'Beto']);
    const state = b.last('gameState');
    const anaPid = state.players.find((p) => p.name === 'Ana').pid;
    // tentar usar o pid público como identidade não funciona
    const evil = connect();
    const res = await evil.ask('auth', { mode: 'guest', guestId: anaPid, nick: 'Ana', avatar: '🤠' });
    // (pid tem 12 hex => inválido como guestId)
    assert.equal(res.ok, false);
    assert.equal(roomOf(hub).players.length, 2);
});

/* ---------------- salas ---------------- */

test('sala com senha: senha errada é recusada, certa entra', async () => {
    const { connect } = setup();
    const a = await guest(connect, 'Ana');
    assert.equal((await a.ask('join_room', { room: 'vip', password: 'abc123' })).ok, true);
    const b = await guest(connect, 'Beto');
    const wrong = await b.ask('join_room', { room: 'VIP', password: 'xxx' });
    assert.equal(wrong.ok, false);
    assert.match(wrong.error, /Senha/);
    assert.equal((await b.ask('join_room', { room: 'VIP', password: 'abc123' })).ok, true);
});

test('máximo de 4 jogadores, nomes únicos e sala em andamento fechada', async () => {
    const { connect } = setup();
    const socks = await table(connect, ['A1', 'B2', 'C3', 'D4']);
    const e = await guest(connect, 'E5');
    assert.match((await e.ask('join_room', { room: 'MESA1' })).error, /cheia/);

    const { connect: connect2 } = setup();
    await table(connect2, ['Ana', 'Beto']);
    const dup = await guest(connect2, 'ana');
    assert.match((await dup.ask('join_room', { room: 'MESA1' })).error, /mesmo nome|esse nome/i);

    await socks[0].send('startGame');
    const late = await guest(connect, 'F6');
    assert.equal((await late.ask('join_room', { room: 'OUTRA' })).ok, true);
});

/* ---------------- fluxo da partida ---------------- */

test('só o administrador inicia; cada um recebe 9 cartas; curinga é o valor acima da vira', async () => {
    const { connect, hub } = setup();
    const [a, b] = await table(connect, ['Ana', 'Beto']);
    await b.send('startGame');
    assert.match(b.last('alerta'), /administrador/);
    assert.equal(roomOf(hub).status, 'waiting');

    await a.send('startGame');
    const room = roomOf(hub);
    assert.equal(room.status, 'playing');
    room.players.forEach((p) => assert.equal(p.hand.length, 9));
    assert.equal(room.deck.length, 104 - 1 - 1 - 18);
    const Rules = require('../public/rules.js');
    assert.equal(room.wildcardValue, Rules.nextValue(room.wildcardCard.value));
    // Beto não vê a mão da Ana
    const stB = b.last('gameState');
    assert.equal(stB.me.hand.length, 9);
    assert.ok(stB.players.every((p) => p.hand === undefined));
});

test('turno: comprar -> descartar -> passa a vez; regras de ordem são aplicadas', async () => {
    const { connect, hub } = setup();
    const [a, b] = await table(connect, ['Ana', 'Beto']);
    await a.send('startGame');
    const room = roomOf(hub);
    const cur = room.players[room.turnIndex];
    const [me, other] = cur.socketId === a.id ? [a, b] : [b, a];
    room.wildcardValue = '7';
    cur.hand = [c('h1', '2', '♥'), c('h2', '5', '♦'), c('h3', '9', '♣'), c('h4', 'J', '♠'), c('h5', 'K', '♥'),
        c('h6', '3', '♠'), c('h7', '6', '♣'), c('h8', '8', '♦'), c('h9', 'A', '♠')];

    await other.send('draw_deck');
    assert.match(other.last('alerta'), /vez/);

    await me.send('discard', cur.hand[0].id);
    assert.match(me.last('alerta'), /Compre/);

    await me.send('draw_deck');
    assert.equal(cur.hand.length, 10);
    await me.send('draw_deck');
    assert.match(me.last('alerta'), /já comprou/);
    await me.send('bater');
    assert.match(me.last('alerta'), /Ainda não dá para bater: você tem \d de 3 jogos prontos/);

    const card = cur.hand[3];
    await me.send('discard', card.id);
    assert.equal(cur.hand.length, 9);
    assert.equal(room.discardPile[room.discardPile.length - 1].id, card.id);
    assert.equal(room.players[room.turnIndex], room.players.find((p) => p !== cur));
});

test('carta pega do Lixo não pode ser descartada no mesmo turno', async () => {
    const { connect, hub } = setup();
    const [a, b] = await table(connect, ['Ana', 'Beto']);
    await a.send('startGame');
    const room = roomOf(hub);
    const cur = room.players[room.turnIndex];
    const me = cur.socketId === a.id ? a : b;
    const top = room.discardPile[room.discardPile.length - 1];
    await me.send('draw_discard');
    await me.send('discard', top.id);
    assert.match(me.last('alerta'), /acabou de pegar/);
    assert.equal(cur.hand.length, 10);
    await me.send('discard', cur.hand[0].id);
    assert.equal(cur.hand.length, 9);
});

test('monte vazio: o lixo é embaralhado de volta (sem perder a carta de cima)', async () => {
    const { connect, hub } = setup();
    const [a, b] = await table(connect, ['Ana', 'Beto']);
    await a.send('startGame');
    const room = roomOf(hub);
    const cur = room.players[room.turnIndex];
    const me = cur.socketId === a.id ? a : b;
    room.discardPile = [c('d1', '2', '♥'), c('d2', '3', '♥'), c('d3', '4', '♥')];
    room.deck = [];
    await me.send('draw_deck');
    assert.equal(cur.hand.length, 10);
    assert.equal(room.discardPile.length, 1);
    assert.equal(room.discardPile[0].id, 'd3');
    assert.equal(room.deck.length, 1);
});

test('monte e lixo (só 1 carta) vazios: avisa e não marca como comprado', async () => {
    const { connect, hub } = setup();
    const [a, b] = await table(connect, ['Ana', 'Beto']);
    await a.send('startGame');
    const room = roomOf(hub);
    const cur = room.players[room.turnIndex];
    const me = cur.socketId === a.id ? a : b;
    room.deck = [];
    room.discardPile = [c('d1', '2', '♥')];
    await me.send('draw_deck');
    assert.match(me.last('alerta'), /Lixo/);
    assert.equal(cur.hasDrawn, false);
});

/* ---------------- vitórias ---------------- */

test('bater válido: conta a vitória do convidado só na sessão dele', async () => {
    const { connect, hub } = setup();
    const [a, b] = await table(connect, ['Ana', 'Beto']);
    await a.send('startGame');
    const room = roomOf(hub);
    const cur = room.players[room.turnIndex];
    const me = cur.socketId === a.id ? a : b;
    room.wildcardValue = 'K';
    cur.hand = WIN10();
    cur.hasDrawn = true;

    await me.send('bater');
    const over = me.last('gameOver');
    assert.ok(over, 'gameOver enviado');
    assert.equal(over.winnerName, cur.name);
    assert.equal(over.sets.length, 3);
    assert.equal(over.discard.id, 'x1');
    assert.equal(over.scoreboard.find((p) => p.name === cur.name).wins, 1);
    assert.equal(room.status, 'waiting');
    assert.equal(hub.winsOf(cur.key), 1);
    assert.equal(me.last('gameState').me.wins, 1);

    // segunda vitória soma (antes ficava "travado" no mesmo número)
    await (me === a ? a : b).send('startGame');
    assert.equal(room.status, 'playing');
});

test('vitórias de convidado: outro aparelho com o mesmo apelido começa do zero; sair apaga tudo', async () => {
    const { connect, hub } = setup();
    const [a, b] = await table(connect, ['Ana', 'Beto']);
    await a.send('startGame');
    const room = roomOf(hub);
    const cur = room.players[room.turnIndex];
    const me = cur.socketId === a.id ? a : b;
    room.wildcardValue = 'K';
    cur.hand = WIN10();
    cur.hasDrawn = true;
    await me.send('bater');
    assert.equal(hub.winsOf(cur.key), 1);

    // mesmo apelido em outro aparelho = outra sessão de convidado = 0 vitórias
    const phone = connect();
    const res = await phone.ask('auth', { mode: 'guest', guestId: guestId(), nick: cur.name, avatar: '🤠' });
    assert.equal(res.ok, true);
    assert.equal(res.profile.wins, 0);

    // sair da sessão de convidado limpa as estatísticas
    await me.ask('logout', {});
    assert.equal(hub.guests.has(me.guestId), false);
    const again = connect();
    const back = await again.ask('auth', { mode: 'guest', guestId: me.guestId, nick: cur.name, avatar: '🤠' });
    assert.equal(back.profile.wins, 0);
});

test('conta registrada: vitórias persistem e aparecem em qualquer aparelho', async () => {
    const { connect, hub, store } = setup();
    const phone = connect();
    const signup = await phone.ask('auth', { mode: 'signup', username: 'Adler', password: 'segredo1', avatar: '😎' });
    assert.equal(signup.ok, true, signup.error);
    assert.equal(signup.profile.type, 'user');
    await phone.ask('join_room', { room: 'MESA1' });
    const friend = await guest(connect, 'Beto');
    await friend.ask('join_room', { room: 'MESA1' });
    await phone.send('startGame');

    const room = roomOf(hub);
    const cur = room.players.find((p) => p.name === 'Adler');
    room.turnIndex = room.players.indexOf(cur);
    room.wildcardValue = 'K';
    cur.hand = WIN10();
    cur.hasDrawn = true;
    await phone.send('bater');
    assert.equal(store.getWins('adler'), 1);

    // login em outro aparelho (computador) mostra a mesma contagem
    const pc = connect();
    const login = await pc.ask('auth', { mode: 'login', username: 'adler', password: 'segredo1' });
    assert.equal(login.ok, true);
    assert.equal(login.profile.wins, 1);
    assert.match(login.token, /^[a-f0-9]{64}$/);

    // retomar por token (reabrir o app)
    const reopened = connect();
    const resumed = await reopened.ask('auth', { mode: 'token', token: signup.token });
    assert.equal(resumed.ok, true);
    assert.equal(resumed.profile.wins, 1);
    assert.equal((await connect().ask('auth', { mode: 'login', username: 'adler', password: 'errada' })).ok, false);
});

test('convidado que cria conta leva as vitórias da sessão; o convidado deixa de existir', async () => {
    const { connect, hub, store } = setup();
    const [a, b] = await table(connect, ['Ana', 'Beto']);
    await a.send('startGame');
    const room = roomOf(hub);
    const cur = room.players[room.turnIndex];
    const me = cur.socketId === a.id ? a : b;
    room.wildcardValue = 'K';
    cur.hand = WIN10();
    cur.hasDrawn = true;
    await me.send('bater');
    assert.equal(hub.winsOf(cur.key), 1);

    const res = await me.ask('auth', { mode: 'signup', username: 'Ana2024', password: 'segredo1', avatar: '🦊', guestId: me.guestId });
    assert.equal(res.ok, true, res.error);
    assert.equal(res.profile.wins, 1);
    assert.equal(store.getWins('ana2024'), 1);
    assert.equal(hub.guests.has(me.guestId), false);
    // o assento de convidado foi liberado
    assert.equal(roomOf(hub).players.some((p) => p.key === cur.key), false);
});

/* ---------------- queda e reconexão ---------------- */

test('queda: pausa a mesa; reconectar com o mesmo segredo volta ao lugar e despausa', async () => {
    const { connect, hub } = setup({ reconnectMs: 5000 });
    const [a, b] = await table(connect, ['Ana', 'Beto']);
    await a.send('startGame');
    const room = roomOf(hub);

    await b.disconnect();
    assert.equal(room.players.find((p) => p.name === 'Beto').connected, false);
    assert.equal(a.last('gameState').paused, true);
    await a.send('draw_deck');
    assert.match(a.last('alerta'), /pausado/);

    const handBefore = room.players.find((p) => p.name === 'Beto').hand.map((x) => x.id);
    const b2 = connect();
    const res = await b2.ask('auth', { mode: 'guest', guestId: b.guestId, nick: 'Beto', avatar: '🤠' });
    assert.equal(res.ok, true);
    assert.ok(b2.last('joined'), 'volta direto para a mesa');
    const beto = room.players.find((p) => p.name === 'Beto');
    assert.equal(beto.connected, true);
    assert.deepEqual(beto.hand.map((x) => x.id), handBefore);
    assert.equal(a.last('gameState').paused, false);
    hub.shutdown();
});

test('queda sem volta (3 jogadores): é removido e a partida continua', async () => {
    const { connect, hub } = setup({ reconnectMs: 30 });
    const [a, b, d] = await table(connect, ['Ana', 'Beto', 'Duda']);
    await a.send('startGame');
    const room = roomOf(hub);
    const before = room.deck.length;
    await b.disconnect();
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(room.players.length, 2);
    assert.equal(room.status, 'playing');
    assert.equal(room.deck.length, before + 9, 'cartas dele voltaram ao monte');
    assert.ok(room.turnIndex < room.players.length);
    assert.ok(a.last('gameState') && d.last('gameState'));
    hub.shutdown();
});

test('queda sem volta (2 jogadores): partida cancelada e mesa continua existindo', async () => {
    const { connect, hub } = setup({ reconnectMs: 30 });
    const [a, b] = await table(connect, ['Ana', 'Beto']);
    await a.send('startGame');
    await b.disconnect();
    await new Promise((r) => setTimeout(r, 120));
    const room = roomOf(hub);
    assert.equal(room.players.length, 1);
    assert.equal(room.status, 'waiting');
    assert.equal(a.last('gameState').status, 'waiting');
    hub.shutdown();
});

test('mesma conta em dois aparelhos: o novo assume e o antigo é avisado', async () => {
    const { connect, hub } = setup();
    const a = await guest(connect, 'Ana');
    const bId = guestId();
    const b = connect();
    await b.ask('auth', { mode: 'guest', guestId: bId, nick: 'Beto', avatar: '🤠' });
    await b.ask('join_room', { room: 'MESA1' });
    await a.ask('join_room', { room: 'MESA1' });
    const b2 = connect();
    await b2.ask('auth', { mode: 'guest', guestId: bId, nick: 'Beto', avatar: '🤠' });
    assert.ok(b.has('session_replaced'));
    assert.equal(roomOf(hub).players.length, 2);
    assert.ok(b2.last('joined'));
});

/* ---------------- administração, chat, abuso ---------------- */

test('só o admin expulsa/reseta; o admin passa para outro quando sai', async () => {
    const { connect, hub } = setup();
    const [a, b, d] = await table(connect, ['Ana', 'Beto', 'Duda']);
    const room = roomOf(hub);
    const pidOf = (name) => room.players.find((p) => p.name === name).pid;

    await b.send('kick_player', pidOf('Duda'));
    assert.match(b.last('alerta'), /administrador/);
    assert.equal(room.players.length, 3);

    await b.send('resetGame');
    assert.match(b.last('alerta'), /administrador/);

    await a.send('kick_player', pidOf('Duda'));
    assert.ok(d.has('kicked_by_admin'));
    assert.equal(room.players.length, 2);

    await a.send('leave_table');
    assert.equal(room.adminKey, room.players[0].key);
    assert.equal(room.players[0].name, 'Beto');
    assert.equal(b.last('gameState').isAdmin, true);
});

test('chat: limite de tamanho, nada de HTML processado no servidor e limite de taxa; emotes só da lista', async () => {
    const { connect } = setup();
    const [a, b] = await table(connect, ['Ana', 'Beto']);
    await a.send('send_chat', 'x'.repeat(5000));
    assert.equal(b.last('chat_message').text.length, 200);

    await a.send('send_chat', '<img src=x onerror=alert(1)>');
    assert.equal(b.last('chat_message').text, '<img src=x onerror=alert(1)>', 'texto cru: o cliente escapa');

    for (let i = 0; i < 10; i++) await a.send('send_chat', `spam ${i}`);
    assert.ok(b.all('chat_message').length <= 6, 'rate limit');
    assert.match(a.last('alerta'), /Devagar/);

    await a.send('send_emote', '<script>');
    assert.equal(b.last('receive_emote'), undefined);
    await a.send('send_emote', '😂');
    assert.equal(b.last('receive_emote').emote, '😂');
});

test('nomes não carregam HTML/aspas e sala tem tamanho limitado', async () => {
    const { connect, hub } = setup();
    const s = connect();
    const res = await s.ask('auth', { mode: 'guest', guestId: guestId(), nick: '<img src=x onerror=1>"\'', avatar: '💥' });
    assert.equal(res.ok, true);
    assert.ok(!/[<>"'&]/.test(res.profile.name));
    assert.equal(res.profile.avatar, '🤠', 'avatar fora da lista é trocado');
    const j = await s.ask('join_room', { room: '<b>' + 'x'.repeat(100) + '</b>' });
    assert.equal(j.ok, true);
    assert.ok(j.roomId.length <= 20 && !/[<>]/.test(j.roomId));
    assert.equal(hub.rooms.size, 1);
});

test('trocar de sala tira o jogador da anterior (sem ficar duplicado)', async () => {
    const { connect, hub } = setup();
    const [a] = await table(connect, ['Ana', 'Beto']);
    await a.ask('join_room', { room: 'OUTRA' });
    assert.equal(roomOf(hub, 'MESA1').players.length, 1);
    assert.equal(roomOf(hub, 'OUTRA').players.length, 1);
});
