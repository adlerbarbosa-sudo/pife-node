const socket = io();
let currentLayout = 'layout-overlap';
let localHand = []; 
let currentWildcardValue = null;
let isFirstDeal = true;

// Variáveis do Sistema de Arraste Fantasma
let draggingCardIndex = null;
let ghostElement = null;
let targetInsertIndex = null;
let dragStartX = 0;
let dragStartY = 0;
let isMoved = false;

// Sintetizador de Áudio Nativo
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
        osc.frequency.setValueAtTime(554.37, audioCtx.currentTime + 0.1);
        osc.frequency.setValueAtTime(659.25, audioCtx.currentTime + 0.2);
        gainNode.gain.setValueAtTime(0.1, audioCtx.currentTime);
        gainNode.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 0.4);
        osc.start(); osc.stop(audioCtx.currentTime + 0.4);
    }
}

socket.on('alerta', alert);
socket.on('play_sound', playSFX);
socket.on('game_started', () => { isFirstDeal = true; });

function register() {
    const name = document.getElementById('username').value;
    const avatar = document.querySelector('input[name="avatar"]:checked').value;
    
    if (name.trim()) {
        socket.emit('register', { name, avatar });
        document.getElementById('login-screen').style.display = 'none';
        document.getElementById('game-screen').style.display = 'flex';
        document.getElementById('chat-panel').style.display = 'flex';
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

function getSuitColor(suit) { return (suit === '♥' || suit === '♦') ? 'red' : 'black'; }

function renderCardHTML(card, isWildcard = false, addAnim = false) {
    if (!card) return `<div class="card empty">Vazio</div>`;
    const wcClass = isWildcard ? 'is-wildcard' : '';
    const animClass = addAnim ? 'animate-deal' : '';
    
    return `
        <div id="card-${card.id}" class="card ${getSuitColor(card.suit)} ${wcClass} ${animClass}"
             oncontextmenu="toggleGroup('${card.id}'); return false;"
             ondblclick="toggleGroup('${card.id}')">
            <div class="card-mini">${card.value}<br>${card.suit}</div>
            <div class="card-center">${card.suit}</div>
            <div class="card-mini-bottom">${card.value}<br>${card.suit}</div>
        </div>
    `;
}

// ==========================================
// SISTEMA DE ARRASTE E DESCARTE FLUIDO
// ==========================================
function initCardDrag(e, index) {
    if (e.button !== 0 && e.type !== 'touchstart') return; 

    draggingCardIndex = index;
    isMoved = false;
    
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    dragStartX = clientX;
    dragStartY = clientY;
    
    const cardObj = localHand[index];
    const cardEl = document.getElementById(`card-${cardObj.id}`);
    
    // Cria o Rastro Fantasma
    ghostElement = cardEl.cloneNode(true);
    ghostElement.id = 'ghost-card';
    ghostElement.classList.add('ghost-card');
    document.body.appendChild(ghostElement);
    
    cardEl.classList.add('dragging-origin');
    updateGhostPosition(clientX, clientY);
    
    window.addEventListener('mousemove', onDragMove);
    window.addEventListener('touchmove', onDragMove, { passive: false });
    window.addEventListener('mouseup', onDragEnd);
    window.addEventListener('touchend', onDragEnd);
}

function updateGhostPosition(x, y) {
    if (ghostElement) {
        ghostElement.style.left = `${x - 40}px`;
        ghostElement.style.top = `${y - 50}px`;
    }
}

function isOverDiscardArea(x, y) {
    const discardEl = document.getElementById('discard-container');
    if (!discardEl) return false;
    const rect = discardEl.getBoundingClientRect();
    return (x >= rect.left - 30 && x <= rect.right + 30 && y >= rect.top - 30 && y <= rect.bottom + 30);
}

function onDragMove(e) {
    if (draggingCardIndex === null) return;

    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    
    // Detecta se o usuário realmente arrastou mais de 8px
    if (Math.abs(clientX - dragStartX) > 8 || Math.abs(clientY - dragStartY) > 8) {
        isMoved = true;
    }

    if (isMoved && e.cancelable) e.preventDefault();
    updateGhostPosition(clientX, clientY);

    // Destaca o Lixo se estiver arrastando por cima dele
    const discardArea = document.querySelector('.deck-area:nth-child(3)');
    if (isOverDiscardArea(clientX, clientY)) {
        discardArea?.classList.add('drop-target');
    } else {
        discardArea?.classList.remove('drop-target');
    }

    // Calcula a nova posição de encaixe dentro da mão
    const handArea = document.getElementById('my-hand');
    const cardsElements = Array.from(handArea.querySelectorAll('.card:not(.ghost-card)'));
    
    let newInsertIndex = cardsElements.length;
    for (let i = 0; i < cardsElements.length; i++) {
        const rect = cardsElements[i].getBoundingClientRect();
        const cardMiddleX = rect.left + rect.width / 2;
        if (clientX < cardMiddleX) {
            newInsertIndex = i;
            break;
        }
    }

    if (newInsertIndex !== targetInsertIndex) {
        targetInsertIndex = newInsertIndex;
        updateDropPlaceholder();
    }
}

function updateDropPlaceholder() {
    const handArea = document.getElementById('my-hand');
    let placeholder = document.getElementById('drop-placeholder');
    
    if (!placeholder) {
        placeholder = document.createElement('div');
        placeholder.id = 'drop-placeholder';
        placeholder.className = 'drop-placeholder';
    }
    
    const cardsElements = Array.from(handArea.children).filter(el => el.id !== 'drop-placeholder');
    if (targetInsertIndex >= cardsElements.length) {
        handArea.appendChild(placeholder);
    } else {
        handArea.insertBefore(placeholder, cardsElements[targetInsertIndex]);
    }
}

function onDragEnd(e) {
    if (draggingCardIndex === null) return;

    const clientX = e.changedTouches ? e.changedTouches[0].clientX : e.clientX;
    const clientY = e.changedTouches ? e.changedTouches[0].clientY : e.clientY;

    window.removeEventListener('mousemove', onDragMove);
    window.removeEventListener('touchmove', onDragMove);
    window.removeEventListener('mouseup', onDragEnd);
    window.removeEventListener('touchend', onDragEnd);

    document.querySelector('.deck-area:nth-child(3)')?.classList.remove('drop-target');

    if (ghostElement) {
        ghostElement.remove();
        ghostElement = null;
    }

    const placeholder = document.getElementById('drop-placeholder');
    if (placeholder) placeholder.remove();

    const cardObj = localHand[draggingCardIndex];

    // CASO 1: Foi solto em cima do Lixo -> Descarta diretamente
    if (isMoved && isOverDiscardArea(clientX, clientY)) {
        socket.emit('discard', cardObj.id);
    } 
    // CASO 2: Foi apenas um Clique/Toque rápido sem arrastar -> Pergunta se quer descartar
    else if (!isMoved) {
        if (confirm(`Deseja descartar a carta ${cardObj.value}${cardObj.suit}?`)) {
            socket.emit('discard', cardObj.id);
        }
    } 
    // CASO 3: Arrasto comum -> Reorganiza a posição na mão
    else if (targetInsertIndex !== null) {
        const [movedCard] = localHand.splice(draggingCardIndex, 1);
        let finalIndex = targetInsertIndex;
        if (draggingCardIndex < targetInsertIndex) finalIndex--;
        localHand.splice(finalIndex, 0, movedCard);
    }

    draggingCardIndex = null;
    targetInsertIndex = null;
    renderHand();
}

function renderHand() {
    const handArea = document.getElementById('my-hand');
    handArea.className = `hand-area ${currentLayout}`;
    handArea.innerHTML = localHand.map((card, index) => {
        let isWildcard = (card.value === currentWildcardValue);
        let html = renderCardHTML(card, isWildcard, isFirstDeal);
        
        if(currentLayout === 'layout-fan') {
            let offset = index - (localHand.length / 2);
            let rot = offset * 8; 
            html = html.replace('class="card', `style="transform: rotate(${rot}deg);" class="card`);
        }
        return html;
    }).join('');

    localHand.forEach((card, index) => {
        const cardEl = document.getElementById(`card-${card.id}`);
        if (cardEl) {
            cardEl.onmousedown = (e) => initCardDrag(e, index);
            cardEl.ontouchstart = (e) => initCardDrag(e, index);
        }
    });

    if (localHand.length > 0) isFirstDeal = false;
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

    document.getElementById('wildcard-container').innerHTML = renderCardHTML(state.wildcardCard, false, false);
    document.getElementById('wildcard-text').innerText = state.wildcardValue || '-';

    const topDiscard = state.discardPile.length > 0 ? state.discardPile[state.discardPile.length - 1] : null;
    document.getElementById('discard-container').innerHTML = renderCardHTML(topDiscard, false, false);

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
    playSFX('win');
    
    document.getElementById('game-screen').style.display = 'none';
    document.getElementById('game-over-screen').style.display = 'flex';
    document.getElementById('winner-msg').innerHTML = `🎉 ${data.winner} BATEU! 🎉`;
    
    let html = data.winningSets.map(set => `
        <div class="set-group">
            ${set.map(card => renderCardHTML(card, card.value === currentWildcardValue, false)).join('')}
        </div>
    `).join('');

    if (data.discard) {
        html += `<div class="set-group" style="margin-left: 50px; opacity: 0.7;">
            <div><small style="color:#fff;">Descarte:</small><br>${renderCardHTML(data.discard, false, false)}</div>
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