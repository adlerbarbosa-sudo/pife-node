const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

let gameState = {
    status: 'waiting',
    players: [],
    deck: [],
    discardPile: [],
    wildcardCard: null,
    wildcardValue: null,
    turnIndex: 0
};

let disconnectTimers = {}; 

const cardValues = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const cardValueToNum = { 'A':1, '2':2, '3':3, '4':4, '5':5, '6':6, '7':7, '8':8, '9':9, '10':10, 'J':11, 'Q':12, 'K':13 };

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

function isGamePaused() {
    return gameState.players.some(p => !p.connected);
}

function updateClients() {
    const currentTurnPlayer = gameState.players[gameState.turnIndex];
    const isPaused = isGamePaused();
    
    gameState.players.forEach(p => {
        if (!p.connected) return; 
        
        const publicState = {
            status: gameState.status,
            isPaused: isPaused,
            deckCount: gameState.deck.length, // NOVO: Contador de cartas
            discardPile: gameState.discardPile,
            wildcardCard: gameState.wildcardCard,
            wildcardValue: gameState.wildcardValue,
            turn: gameState.status === 'playing' && currentTurnPlayer ? currentTurnPlayer.id : null,
            opponents: gameState.players.filter(op => op.id !== p.id).map(op => ({
                id: op.id,
                name: op.name,
                avatar: op.avatar,
                cardCount: op.hand.length,
                wins: op.wins,
                connected: op.connected,
                isTurn: (gameState.status === 'playing' && currentTurnPlayer && op.id === currentTurnPlayer.id)
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

function kickPlayer(sessionId) {
    const player = gameState.players.find(p => p.sessionId === sessionId);
    if (!player) return;
    
    gameState.players = gameState.players.filter(p => p.sessionId !== sessionId);
    
    if (gameState.status === 'playing') {
        gameState.status = 'waiting';
        gameState.deck = [];
        gameState.discardPile = [];
        gameState.wildcardCard = null;
        gameState.wildcardValue = null;
        gameState.turnIndex = 0;
        gameState.players.forEach(p => { p.hand = []; p.hasDrawnThisTurn = false; });
        io.emit('chat_system', `💔 ${player.avatar} ${player.name} não retornou a tempo. Jogo cancelado.`);
    } else if (gameState.players.length < 2) {
        gameState.status = 'waiting';
    }
    updateClients();
}

io.on('connection', (socket) => {
    
    socket.on('register', (data) => {
        let existingPlayer = gameState.players.find(p => p.sessionId === data.sessionId);

        if (existingPlayer) {
            existingPlayer.id = socket.id;
            existingPlayer.name = data.name; 
            existingPlayer.avatar = data.avatar;
            existingPlayer.connected = true;

            if (disconnectTimers[data.sessionId]) {
                clearTimeout(disconnectTimers[data.sessionId]);
                delete disconnectTimers[data.sessionId];
            }
            io.emit('chat_system', `✅ ${existingPlayer.avatar} ${existingPlayer.name} reconectou!`);
        } else {
            if (gameState.players.length >= 4) return socket.emit('alerta', 'Mesa cheia (Máx 4).');
            if (gameState.status === 'playing') return socket.emit('alerta', 'Jogo em andamento, aguarde na tela inicial.');
            
            gameState.players.push({ 
                id: socket.id, 
                sessionId: data.sessionId,
                name: data.name, 
                avatar: data.avatar, 
                hand: [], 
                hasDrawnThisTurn: false, 
                wins: 0,
                connected: true
            });
            io.emit('chat_system', `🟢 ${data.avatar} ${data.name} entrou na mesa.`);
        }
        
        socket.emit('registered_success');
        updateClients();
    });

    socket.on('send_chat', (msg) => {
        const player = gameState.players.find(p => p.id === socket.id);
        if (player && msg.trim()) {
            io.emit('chat_message', { sender: `${player.avatar} ${player.name}`, text: msg.trim() });
        }
    });

    // Rota das Reações Animadas (Emotes)
    socket.on('send_emote', (emote) => {
        const player = gameState.players.find(p => p.id === socket.id);
        if (player) {
            io.emit('receive_emote', { id: player.id, emote });
        }
    });

    socket.on('startGame', () => {
        if (gameState.players.length < 2) return socket.emit('alerta', 'Mínimo de 2 jogadores!');
        if (gameState.status === 'playing') return;
        if (isGamePaused()) return socket.emit('alerta', 'Aguarde todos reconectarem!');

        gameState.deck = createDeck();
        gameState.wildcardCard = gameState.deck.pop(); 
        gameState.wildcardValue = getNextValue(gameState.wildcardCard.value);
        
        gameState.discardPile = [gameState.deck.pop()]; 
        gameState.turnIndex = 0;
        
        gameState.players.forEach(p => {
            p.hand = gameState.deck.splice(0, 9);
            p.hasDrawnThisTurn = false;
        });
        
        gameState.status = 'playing';
        io.emit('chat_system', '🎲 O jogo começou! Boa sorte.');
        io.emit('game_started');
        updateClients();
    });

    socket.on('draw_deck', () => {
        if (gameState.status !== 'playing') return socket.emit('alerta', 'O jogo não começou!');
        if (isGamePaused()) return socket.emit('alerta', 'Jogo pausado: alguém caiu!');
        
        const player = gameState.players[gameState.turnIndex];
        if (!player || player.id !== socket.id) return socket.emit('alerta', 'Não é seu turno!');
        if (player.hasDrawnThisTurn) return socket.emit('alerta', 'Você já comprou.');
        
        if (gameState.deck.length === 0) {
            gameState.deck = gameState.discardPile.splice(0, gameState.discardPile.length - 1).sort(() => Math.random() - 0.5);
            io.emit('chat_system', `♻️ O Lixo foi embaralhado de volta para o Monte!`);
        }
        const card = gameState.deck.pop();
        if(card) player.hand.push(card);
        player.hasDrawnThisTurn = true;
        
        socket.emit('play_sound', 'draw');
        updateClients();
    });

    socket.on('draw_discard', () => {
        if (gameState.status !== 'playing') return socket.emit('alerta', 'O jogo não começou!');
        if (isGamePaused()) return socket.emit('alerta', 'Jogo pausado: alguém caiu!');
        
        const player = gameState.players[gameState.turnIndex];
        if (!player || player.id !== socket.id) return socket.emit('alerta', 'Não é seu turno!');
        if (player.hasDrawnThisTurn) return socket.emit('alerta', 'Você já comprou.');
        if (gameState.discardPile.length === 0) return socket.emit('alerta', 'Lixo vazio.');
        
        const card = gameState.discardPile.pop();
        player.hand.push(card);
        player.hasDrawnThisTurn = true;
        
        io.emit('chat_system', `📜 ${player.avatar} pegou o Lixo (${card.value}${card.suit}).`);
        socket.emit('play_sound', 'draw');
        updateClients();
    });

    socket.on('discard', (cardId) => {
        if (gameState.status !== 'playing' || isGamePaused()) return;
        
        const player = gameState.players[gameState.turnIndex];
        if (!player || player.id !== socket.id) return socket.emit('alerta', 'Não é seu turno!');
        if (!player.hasDrawnThisTurn) return socket.emit('alerta', 'Compre antes de descartar.');
        
        const cardIndex = player.hand.findIndex(c => c.id === cardId);
        if (cardIndex > -1) {
            const card = player.hand.splice(cardIndex, 1)[0];
            gameState.discardPile.push(card);
            player.hasDrawnThisTurn = false;
            gameState.turnIndex = (gameState.turnIndex + 1) % gameState.players.length;
            
            socket.emit('play_sound', 'discard');
            updateClients();
        }
    });

    socket.on('bater', () => {
        if (gameState.status !== 'playing' || isGamePaused()) return;
        
        const player = gameState.players.find(p => p.id === socket.id);
        if (!player) return;
        if (gameState.players[gameState.turnIndex]?.id !== socket.id) return socket.emit('alerta', 'Bata no seu turno!');
        
        const result = validatePife(player.hand, gameState.wildcardValue);
        
        if (result) {
            player.wins += 1; 
            io.emit('gameOver', { winner: player.name, winningSets: result.sets, discard: result.discard });
            io.emit('chat_system', `🏆 ${player.avatar} ${player.name} BATEU E GANHOU A RODADA!`);
            gameState.status = 'waiting';
            gameState.players.forEach(p => p.hand = []);
            updateClients(); 
        } else {
            socket.emit('alerta', 'Jogo inválido! Suas cartas não formam 3 trincas/sequências válidas.');
        }
    });

    socket.on('resetGame', () => {
        const player = gameState.players.find(p => p.id === socket.id);
        gameState.status = 'waiting';
        gameState.deck = [];
        gameState.discardPile = [];
        gameState.wildcardCard = null;
        gameState.wildcardValue = null;
        gameState.turnIndex = 0;
        gameState.players.forEach(p => { p.hand = []; p.hasDrawnThisTurn = false; });
        io.emit('chat_system', `⚠️ A mesa foi resetada por ${player ? player.name : 'um jogador'}.`);
        updateClients();
    });

    socket.on('leaveTable', () => {
        const player = gameState.players.find(p => p.id === socket.id);
        if (player) {
            if (disconnectTimers[player.sessionId]) clearTimeout(disconnectTimers[player.sessionId]);
            io.emit('chat_system', `🔴 ${player.avatar} ${player.name} levantou da mesa.`);
            kickPlayer(player.sessionId);
        }
    });

    socket.on('disconnect', () => {
        const player = gameState.players.find(p => p.id === socket.id);
        if (player) {
            player.connected = false;
            
            io.emit('chat_system', `⚠️ A conexão de ${player.name} caiu! Pausando a mesa (60s)...`);
            
            disconnectTimers[player.sessionId] = setTimeout(() => {
                kickPlayer(player.sessionId);
            }, 60000); 
            
            updateClients();
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Rodando na porta ${PORT}`));