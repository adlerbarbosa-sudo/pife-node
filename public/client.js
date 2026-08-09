const socket = io();
let currentLayout = 'layout-overlap';
let localHand = []; 
let currentWildcardValue = null;
let isFirstDeal = true; // Controle para a animação

// ==== SINTETIZADOR DE ÁUDIO NATIVO (Sem arquivos externos) ====
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
function playSFX(type) {
    if(audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();
    osc.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    
    if (type === 'draw') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(300, audioCtx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(500, audioCtx.currentTime + 0.1);
        gainNode.gain.setValueAtTime(0.1, audioCtx.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.1);
        osc.start(); osc.stop(audioCtx.currentTime + 0.1);
    } 
    else if (type === 'discard') {
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(400, audioCtx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(200, audioCtx.currentTime + 0.1);
        gainNode.gain.setValueAtTime(0.1, audioCtx.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.1);
        osc.start(); osc.stop(audioCtx.currentTime + 0.1);
    }
    else if (type === 'win') {
        osc.type = 'square';
        osc.frequency.setValueAtTime(440, audioCtx.currentTime);
        osc.frequency.setValueAtTime(554.37, audioCtx.currentTime + 0.1); // Dó sustenido
        osc.frequency.setValueAtTime(659.25, audioCtx.currentTime + 0.2); // Mi
        gainNode.gain.setValueAtTime(0.1, audioCtx.currentTime);
        gainNode.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 0.4);
        osc.start(); osc.stop(audioCtx.currentTime + 0.4);
    }
}
// ===============================================================

socket.on('alerta', alert);

// Escuta os eventos de som do servidor
socket.on('play_sound', playSFX);

socket.on('game_started', () => {
    isFirstDeal = true;
});

function register() {
    const name = document.getElementById('username').value;
    const avatar = document.querySelector('input[name="avatar"]:checked').value;
    
    if (name.trim()) {
        socket.emit('register', { name, avatar });
        document.getElementById('login-screen').style.display = 'none';
        document.getElementById('game-screen').style.display = 'flex';
        document.getElementById('chat-panel').style.display = 'flex';
        
        // Ativa o áudio no primeiro clique (Regra dos navegadores)
        if(audioCtx.state === 'suspended') audioCtx.resume();
    }
}

function startGame() { socket.emit('startGame'); }
function resetGame() { if(confirm('Resetar a mesa?')) socket.emit('resetGame'); }
function drawDeck() { socket.emit('draw_deck'); }
function drawDiscard() { socket.emit('draw_discard'); }
function bater() { socket.emit('bater'); }

function setLayout(layoutClass) {
    currentLayout = layoutClass;
    renderHand();
}

function toggleGroup(cardId) {
    const cardEl = document.getElementById(`card-${cardId}`);
    if(cardEl) cardEl.classList.toggle('grouped');
}

function discardOrSelect(cardId, event) {
    socket.emit('discard', cardId);
}

function getSuitColor(suit) { return (suit === '♥' || suit === '♦') ? 'red' : 'black'; }

function renderCardHTML(card, action = '', isWildcard = false, isDraggable = true, addAnim = false) {
    if (!card) return `<div class="card empty">Vazio</div>`;
    const wcClass = isWildcard ? 'is-wildcard' : '';
    const animClass = addAnim ? 'animate-deal' : '';
    const dragAttrs = isDraggable ? `draggable="true" ondragstart="dragStart(event, '${card.id}')" ondragover="dragOver(event)" ondrop="drop(event, '${card.id}')"` : '';
    
    return `
        <div id="card-${card.id}" class="card ${getSuitColor(card.suit)} ${wcClass} ${animClass}" 
             onclick="${action}" oncontextmenu="toggleGroup('${card.id}'); return false;"
             ondblclick="toggleGroup('${card.id}')"
             ${dragAttrs}>
            <div class="card-mini">${card.value}<br>${card.suit}</div>
            <div class="card-center">${card.suit}</div>
            <div class="card-mini-bottom">${card.value}<br>${card.suit}</div>
        </div>
    `;
}

let draggedId = null;
function dragStart(e, id) { draggedId = id; }
function dragOver(e) { e.preventDefault(); }
function drop(e, targetId) {
    e.preventDefault();
    if (draggedId === targetId) return;
    const fromIndex = localHand.findIndex(c => c.id === draggedId);
    const toIndex = localHand.findIndex(c => c.id === targetId);
    if(fromIndex < 0 || toIndex < 0) return;
    const [moved] = localHand.splice(fromIndex, 1);
    localHand.splice(toIndex, 0, moved);
    renderHand();
}

function renderHand() {
    const handArea = document.getElementById('my-hand');
    handArea.className = `hand-area ${currentLayout}`;
    handArea.innerHTML = localHand.map((card, index) => {
        let isWildcard = (card.value === currentWildcardValue);
        // Aplica a animação de deslizar apenas na primeira distribuição
        let html = renderCardHTML(card, `discardOrSelect('${card.id}', event)`, isWildcard, true, isFirstDeal);
        
        if(currentLayout === 'layout-fan') {
            let offset = index - (localHand.length / 2);
            let rot = offset * 8; 
            html = html.replace('class="card', `style="transform: rotate(${rot}deg);" class="card`);
        }
        return html;
    }).join('');
    
    if (localHand.length > 0) isFirstDeal = false; // Desliga a animação após a primeira vez
}

socket.on('gameState', (state) => {
    const statusMsg = document.getElementById('status-message');
    document.getElementById('btn-start').style.display = state.status === 'waiting' ? 'block' : 'none';
    
    currentWildcardValue = state.wildcardValue;

    if (state.myName) {
        document.getElementById('player-name').innerHTML = `${state.myAvatar} ${state.myName} <span class="trophy">🏆 ${state.myWins || 0}</span> <span class="penalty">💔 ${state.myScore || 0}</span>`;
    }

    if (state.status !== 'waiting') {
        statusMsg.innerText = (state.turn === socket.id) 
            ? (state.hasDrawnThisTurn ? 'SUA VEZ: Descarte' : 'SUA VEZ: Compre') 
            : 'Aguarde o oponente';
        statusMsg.style.color = (state.turn === socket.id) ? '#c5a85b' : '#aaa';
    } else {
        statusMsg.innerText = 'Aguardando Inicio...';
    }

    document.getElementById('wildcard-container').innerHTML = renderCardHTML(state.wildcardCard, '', false, false);
    document.getElementById('wildcard-text').innerText = state.wildcardValue || '-';

    const topDiscard = state.discardPile.length > 0 ? state.discardPile[state.discardPile.length - 1] : null;
    document.getElementById('discard-container').innerHTML = renderCardHTML(topDiscard, 'drawDiscard()', false, false);

    document.getElementById('opponents-area').innerHTML = state.opponents.map(op => `
        <div class="opponent">
            <h3>${op.avatar} ${op.name}</h3>
            <div><span class="trophy">🏆 ${op.wins || 0}</span> <span class="penalty">💔 ${op.score || 0}</span></div>
            <p>${op.cardCount} cartas</p>
        </div>
    `).join('');

    let newCards = state.myHand.filter(c => !localHand.find(lc => lc.id === c.id));
    localHand = localHand.filter(lc => state.myHand.find(c => c.id === lc.id));
    localHand = [...localHand, ...newCards];
    renderHand();
});

socket.on('gameOver', (data) => {
    playSFX('win'); // Toca o som da vitória
    
    document.getElementById('game-screen').style.display = 'none';
    document.getElementById('game-over-screen').style.display = 'flex';
    document.getElementById('winner-msg').innerHTML = `🎉 ${data.winner} BATEU! 🎉`;
    
    let html = data.winningSets.map(set => `
        <div class="set-group">
            ${set.map(card => renderCardHTML(card, '', card.value === currentWildcardValue, false)).join('')}
        </div>
    `).join('');

    if (data.discard) {
        html += `<div class="set-group" style="margin-left: 50px; opacity: 0.7;">
            <div><small style="color:#fff;">Descarte:</small><br>${renderCardHTML(data.discard, '', false, false)}</div>
        </div>`;
    }
    document.getElementById('winner-hand').innerHTML = html;

    if (typeof confetti === 'function') {
        var duration = 3 * 1000;
        var end = Date.now() + duration;
        (function frame() {
            confetti({ particleCount: 5, angle: 60, spread: 55, origin: { x: 0 }, colors: ['#c5a85b', '#ffffff'] });
            confetti({ particleCount: 5, angle: 120, spread: 55, origin: { x: 1 }, colors: ['#c5a85b', '#ffffff'] });
            if (Date.now() < end) requestAnimationFrame(frame);
        }());
    }
});

function backToLobby() { 
    document.getElementById('game-over-screen').style.display = 'none';
    document.getElementById('game-screen').style.display = 'flex';
}

function sendChatMessage() {
    const input = document.getElementById('chat-input');
    const msg = input.value;
    if (msg.trim()) {
        socket.emit('send_chat', msg);
        input.value = '';
    }
}

function handleChatKey(e) {
    if (e.key === 'Enter') sendChatMessage();
}

function toggleMobileChat() {
    document.getElementById('chat-panel').classList.toggle('mobile-open');
}

socket.on('chat_message', (data) => {
    const msgs = document.getElementById('chat-messages');
    msgs.innerHTML += `<div class="chat-msg"><span>${data.sender}:</span> ${data.text}</div>`;
    msgs.scrollTop = msgs.scrollHeight; 
});

socket.on('chat_system', (msg) => {
    const msgs = document.getElementById('chat-messages');
    msgs.innerHTML += `<div class="chat-msg system">${msg}</div>`;
    msgs.scrollTop = msgs.scrollHeight;
});