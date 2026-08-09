const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};
const socketRoomMap = {}; 

const cardValues = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const cardValueToNum = { 'A':1, '2':2, '3':3, '4':4, '5':5, '6':6, '7':7, '8':8, '9':9, '10':10, 'J':11, 'Q':12, 'K':13 };

function broadcastRoomList() {
    const list = Object.values(rooms).map(r => ({
        id: r.id,
        count: r.players.length,
        hasPassword: !!r.password
    }));
    io.emit('room_list', list);
}

function initRoom(roomId, password = '') {
    if (!rooms[roomId]) {
        rooms[roomId] = {
            id: roomId,
            password: password,
            adminSessionId: null, // Identifica o Dono da Sala
            status: 'waiting',
            players: [],
            deck: [],
            discardPile: [],
            wildcardCard: null,
            wildcardValue: null,
            turnIndex: 0,
            disconnectTimers: {}
        };
        broadcastRoomList();
    }
    return rooms[roomId];
}

function deleteRoomIfEmpty(roomId) {
    if (rooms[roomId] && rooms[roomId].players.length === 0) {
        delete rooms[roomId];
        broadcastRoomList();
    }
}

function createDeck() {
    const suits = ['♥', '♦', '♣', '♠'];
    let deck = [];
    for (let d = 0; d < 2; d++) {
        for (let suit of suits) {
            for (let value of cardValues) {
                deck.push({ id: `${d}-${value}-${suit}-${Math.random().toString(36).substr(2,5)}`, value, suit });
            }
        }
    }
    return deck.sort(() => Math.random() - 0.5);
}

function getNextValue(val) {
    let idx = cardValues.indexOf(val);
    return cardValues[(idx + 1) % cardValues.length];
}

function isValidSet(group, wildcardValue) {
    let normals = group.filter(c => c.value !== wildcardValue);
    let wildcards = group.length - normals.length;

    if (wildcards >= 2) return true; 

    if (wildcards === 1) {
        let [n1, n2] = normals;
        if (n1.value === n2.value) return true;
        if (n1.suit === n2.suit) {
            let v1 = cardValueToNum[n1.value];
            let v2 = cardValueToNum[n2.value];
            if (v1 > v2) { let temp = v1; v1 = v2; v2 = temp; }
            let diff = v2 - v1;
            if (diff === 1 || diff === 2) return true; 
            if (v1 === 1 && v2 === 12) return true; 
            if (v1 === 1 && v2 === 13) return true; 
        }
        return false;
    }

    if (wildcards === 0) {
        let [n1, n2, n3] = normals;
        if (n1.value === n2.value && n2.value === n3.value) return true;
        if (n1.suit === n2.suit && n2.suit === n3.suit) {
            let nums = [cardValueToNum[n1.value], cardValueToNum[n2.value], cardValueToNum[n3.value]].sort((a,b) => a - b);
            if (nums[0] + 1 === nums[1] && nums[1] + 1 === nums[2]) return true;
            if (nums[0] === 1 && nums[1] === 12 && nums[2] === 13) return true;
        }
        return false;
    }
}

function findSets(cards, wildcardValue) {
    if (cards.length === 0) return [];
    let c1 = cards[0];
    for (let i = 1; i < cards.length; i++) {
        for (let j = i + 1; j < cards.length; j++) {
            let c2 = cards[i];
            let c3 = cards[j];
            if (isValidSet([c1, c2, c3], wildcardValue)) {
                let remaining = cards.filter((_, idx) => idx !== 0 && idx !== i && idx !== j);
                let subSets = findSets(remaining, wildcardValue);
                if (subSets !== null) {
                    return [[c1, c2, c3], ...subSets];
                }
            }
        }
    }
    return null;
}

function validatePife(hand, wildcardValue) {
    if (hand.length < 9) return null;
    if (hand.length === 10) {
        for (let i = 0; i < 10; i++) {
            let testHand = hand.filter((_, idx) => idx !== i);
            let sets = findSets(testHand, wildcardValue);
            if (sets) return { sets, discard: hand[i] };
        }
        return null;
    } else {
        let sets = findSets(hand, wildcardValue);
        return sets ? { sets, discard: null } : null;
    }
}

function isGamePaused(room) {
    return room.players.some(p => !p.connected);
}

function updateClients(roomId) {
    const room = rooms[roomId];
    if(!room) return;
    
    const currentTurnPlayer = room.players[room.turnIndex];
    const isPaused = isGamePaused(room);
    
    room.players.forEach(p => {
        if (!p.connected) return; 
        
        const publicState = {
            roomId: room.id,
            status: room.status,
            isPaused: isPaused,
            deckCount: room.deck.length,
            discardPile: room.discardPile,
            wildcardCard: room.wildcardCard,
            wildcardValue: room.wildcardValue,
            turn: room.status === 'playing' && currentTurnPlayer ? currentTurnPlayer.id : null,
            isAdmin: (room.adminSessionId === p.sessionId), // Informa se ele próprio é Admin
            opponents: room.players.filter(op => op.id !== p.id).map(op => ({
                id: op.id,
                sessionId: op.sessionId,
                name: op.name,
                avatar: op.avatar,
                cardCount: op.hand.length,
                wins: op.wins,
                connected: op.connected,
                isAdmin: (room.adminSessionId === op.sessionId), // Informa se o oponente é Admin
                isTurn: (room.status === 'playing' && currentTurnPlayer && op.id === currentTurnPlayer.id)
            })),
            myName: p.name,
            myAvatar: p.avatar,
            myHand: p.hand,
            myWins: p.wins,
            hasDrawnThisTurn: p.hasDrawnThisTurn
        };
        io.to(p.id).emit('gameState', publicState);
    });
}

function kickPlayer(roomId, sessionId) {
    const room = rooms[roomId];
    if(!room) return;
    
    const player = room.players.find(p => p.sessionId === sessionId);
    if (!player) return;
    
    room.players = room.players.filter(p => p.sessionId !== sessionId);
    
    // Transfere a Coroa se o Admin for expulso ou sair
    if (room.adminSessionId === sessionId && room.players.length > 0) {
        room.adminSessionId = room.players[0].sessionId;
    }
    
    if (room.status === 'playing') {
        room.status = 'waiting';
        room.deck = [];
        room.discardPile = [];
        room.wildcardCard = null;
        room.wildcardValue = null;
        room.turnIndex = 0;
        room.players.forEach(p => { p.hand = []; p.hasDrawnThisTurn = false; });
        io.to(roomId).emit('chat_system', `💔 ${player.avatar} ${player.name} foi desconectado. Jogo cancelado.`);
    } else if (room.players.length < 2) {
        room.status = 'waiting';
    }
    
    if (room.players.length === 0) {
        delete rooms[roomId];
    } else {
        updateClients(roomId);
    }
    broadcastRoomList();
}

io.on('connection', (socket) => {
    
    socket.emit('room_list', Object.values(rooms).map(r => ({
        id: r.id, count: r.players.length, hasPassword: !!r.password
    })));

    socket.on('register', (data) => {
        const roomId = data.room.trim().toUpperCase() || 'MESA1';
        
        // Limpeza de Fantasmas Cruzados (Se o cara deu F5 e mudou de sala, apaga ele da sala antiga)
        for (let rId in rooms) {
            if (rId !== roomId) {
                let r = rooms[rId];
                let pIndex = r.players.findIndex(p => p.sessionId === data.sessionId);
                if (pIndex !== -1) {
                    kickPlayer(rId, data.sessionId);
                    socket.leave(rId);
                }
            }
        }

        let room = rooms[roomId];

        if (room) {
            let existingPlayer = room.players.find(p => p.sessionId === data.sessionId);
            
            if (!existingPlayer) {
                if (room.password && room.password !== data.password) {
                    return socket.emit('alerta', 'Senha incorreta para esta sala!');
                }
                if (room.players.length >= 4) {
                    return socket.emit('alerta', 'A mesa escolhida já está cheia (Máx 4).');
                }
                if (room.status === 'playing') {
                    return socket.emit('alerta', 'Jogo em andamento nesta sala, aguarde a rodada acabar.');
                }
            }
        } else {
            room = initRoom(roomId, data.password);
            room.adminSessionId = data.sessionId; // O criador ganha a Coroa
        }

        socket.join(roomId);
        socketRoomMap[socket.id] = roomId;
        
        let existingPlayer = room.players.find(p => p.sessionId === data.sessionId);

        if (existingPlayer) {
            existingPlayer.id = socket.id;
            existingPlayer.name = data.name; 
            existingPlayer.avatar = data.avatar;
            existingPlayer.connected = true;
            
            existingPlayer.wins = Math.max(existingPlayer.wins, data.wins || 0);

            if (room.disconnectTimers[data.sessionId]) {
                clearTimeout(room.disconnectTimers[data.sessionId]);
                delete room.disconnectTimers[data.sessionId];
            }
            io.to(roomId).emit('chat_system', `✅ ${existingPlayer.avatar} ${existingPlayer.name} reconectou!`);
        } else {
            // Se entrou numa sala já com gente e não tem admin, define ele pra garantir
            if (room.players.length === 0) room.adminSessionId = data.sessionId;

            room.players.push({ 
                id: socket.id, 
                sessionId: data.sessionId,
                name: data.name, 
                avatar: data.avatar, 
                hand: [], 
                hasDrawnThisTurn: false, 
                wins: data.wins || 0,
                connected: true
            });
            io.to(roomId).emit('chat_system', `🟢 ${data.avatar} ${data.name} entrou na sala.`);
            broadcastRoomList();
        }
        
        socket.emit('registered_success');
        updateClients(roomId);
    });

    // Função Exclusiva do ADM (Expulsar travados)
    socket.on('kick_player', (targetSessionId) => {
        const roomId = socketRoomMap[socket.id];
        if (!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];
        const player = room.players.find(p => p.id === socket.id);

        if (player && room.adminSessionId === player.sessionId) {
            const target = room.players.find(p => p.sessionId === targetSessionId);
            if (target) {
                if (target.connected) {
                    io.to(target.id).emit('kicked_by_admin');
                }
                kickPlayer(roomId, targetSessionId);
            }
        }
    });

    socket.on('send_chat', (msg) => {
        const roomId = socketRoomMap[socket.id];
        if(!roomId || !rooms[roomId]) return;
        const player = rooms[roomId].players.find(p => p.id === socket.id);
        if (player && msg.trim()) {
            io.to(roomId).emit('chat_message', { sender: `${player.avatar} ${player.name}`, text: msg.trim() });
        }
    });

    socket.on('send_emote', (emote) => {
        const roomId = socketRoomMap[socket.id];
        if(!roomId || !rooms[roomId]) return;
        const player = rooms[roomId].players.find(p => p.id === socket.id);
        if (player) {
            io.to(roomId).emit('receive_emote', { id: player.id, emote });
        }
    });

    socket.on('startGame', () => {
        const roomId = socketRoomMap[socket.id];
        if(!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];

        if (room.players.length < 2) return socket.emit('alerta', 'Mínimo de 2 jogadores!');
        if (room.status === 'playing') return;
        if (isGamePaused(room)) return socket.emit('alerta', 'Aguarde todos reconectarem ou expulse quem caiu!');

        room.deck = createDeck();
        room.wildcardCard = room.deck.pop(); 
        room.wildcardValue = getNextValue(room.wildcardCard.value);
        
        room.discardPile = [room.deck.pop()]; 
        room.turnIndex = 0;
        
        room.players.forEach(p => {
            p.hand = room.deck.splice(0, 9);
            p.hasDrawnThisTurn = false;
        });
        
        room.status = 'playing';
        io.to(roomId).emit('chat_system', '🎲 O jogo começou! Boa sorte.');
        io.to(roomId).emit('game_started');
        updateClients(roomId);
    });

    socket.on('draw_deck', () => {
        const roomId = socketRoomMap[socket.id];
        if(!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];

        if (room.status !== 'playing') return socket.emit('alerta', 'O jogo não começou!');
        if (isGamePaused(room)) return socket.emit('alerta', 'Jogo pausado: alguém caiu!');
        
        const player = room.players[room.turnIndex];
        if (!player || player.id !== socket.id) return socket.emit('alerta', 'Não é seu turno!');
        if (player.hasDrawnThisTurn) return socket.emit('alerta', 'Você já comprou.');
        
        if (room.deck.length === 0) {
            room.deck = room.discardPile.splice(0, room.discardPile.length - 1).sort(() => Math.random() - 0.5);
            io.to(roomId).emit('chat_system', `♻️ O Lixo foi embaralhado de volta para o Monte!`);
        }
        const card = room.deck.pop();
        if(card) player.hand.push(card);
        player.hasDrawnThisTurn = true;
        
        socket.emit('play_sound', 'draw');
        updateClients(roomId);
    });

    socket.on('draw_discard', () => {
        const roomId = socketRoomMap[socket.id];
        if(!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];

        if (room.status !== 'playing') return socket.emit('alerta', 'O jogo não começou!');
        if (isGamePaused(room)) return socket.emit('alerta', 'Jogo pausado: alguém caiu!');
        
        const player = room.players[room.turnIndex];
        if (!player || player.id !== socket.id) return socket.emit('alerta', 'Não é seu turno!');
        if (player.hasDrawnThisTurn) return socket.emit('alerta', 'Você já comprou.');
        if (room.discardPile.length === 0) return socket.emit('alerta', 'Lixo vazio.');
        
        const card = room.discardPile.pop();
        player.hand.push(card);
        player.hasDrawnThisTurn = true;
        
        io.to(roomId).emit('chat_system', `📜 ${player.avatar} pegou o Lixo (${card.value}${card.suit}).`);
        socket.emit('play_sound', 'draw');
        updateClients(roomId);
    });

    socket.on('discard', (cardId) => {
        const roomId = socketRoomMap[socket.id];
        if(!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];

        if (room.status !== 'playing' || isGamePaused(room)) return;
        
        const player = room.players[room.turnIndex];
        if (!player || player.id !== socket.id) return socket.emit('alerta', 'Não é seu turno!');
        if (!player.hasDrawnThisTurn) return socket.emit('alerta', 'Compre antes de descartar.');
        
        const cardIndex = player.hand.findIndex(c => c.id === cardId);
        if (cardIndex > -1) {
            const card = player.hand.splice(cardIndex, 1)[0];
            room.discardPile.push(card);
            player.hasDrawnThisTurn = false;
            room.turnIndex = (room.turnIndex + 1) % room.players.length;
            
            socket.emit('play_sound', 'discard');
            updateClients(roomId);
        }
    });

    socket.on('bater', () => {
        const roomId = socketRoomMap[socket.id];
        if(!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];

        if (room.status !== 'playing' || isGamePaused(room)) return;
        
        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;
        if (room.players[room.turnIndex]?.id !== socket.id) return socket.emit('alerta', 'Bata no seu turno!');
        
        const result = validatePife(player.hand, room.wildcardValue);
        
        if (result) {
            player.wins += 1; 
            io.to(roomId).emit('gameOver', { winner: player.name, winningSets: result.sets, discard: result.discard, newWins: player.wins });
            io.to(roomId).emit('chat_system', `🏆 ${player.avatar} ${player.name} BATEU E GANHOU A RODADA!`);
            room.status = 'waiting';
            room.players.forEach(p => p.hand = []);
            updateClients(roomId); 
        } else {
            socket.emit('alerta', 'Jogo inválido! Suas cartas não formam 3 trincas/sequências válidas.');
        }
    });

    socket.on('resetGame', () => {
        const roomId = socketRoomMap[socket.id];
        if(!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];

        const player = room.players.find(p => p.id === socket.id);
        room.status = 'waiting';
        room.deck = [];
        room.discardPile = [];
        room.wildcardCard = null;
        room.wildcardValue = null;
        room.turnIndex = 0;
        room.players.forEach(p => { p.hand = []; p.hasDrawnThisTurn = false; });
        io.to(roomId).emit('chat_system', `⚠️ A mesa foi resetada por ${player ? player.name : 'um jogador'}.`);
        updateClients(roomId);
    });

    socket.on('leaveTable', () => {
        const roomId = socketRoomMap[socket.id];
        if(!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];

        const player = room.players.find(p => p.id === socket.id);
        if (player) {
            if (room.disconnectTimers[player.sessionId]) clearTimeout(room.disconnectTimers[player.sessionId]);
            io.to(roomId).emit('chat_system', `🔴 ${player.avatar} ${player.name} levantou da mesa.`);
            kickPlayer(roomId, player.sessionId);
        }
        
        socket.leave(roomId);
        delete socketRoomMap[socket.id];
    });

    socket.on('disconnect', () => {
        const roomId = socketRoomMap[socket.id];
        if(!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];

        const player = room.players.find(p => p.id === socket.id);
        if (player) {
            player.connected = false;
            
            io.to(roomId).emit('chat_system', `⚠️ A conexão de ${player.name} caiu! Pausando a mesa (60s)...`);
            
            room.disconnectTimers[player.sessionId] = setTimeout(() => {
                kickPlayer(roomId, player.sessionId);
            }, 60000); 
            
            updateClients(roomId);
        }
        delete socketRoomMap[socket.id]; 
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Rodando na porta ${PORT}`));