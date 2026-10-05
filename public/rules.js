/*
 * Regras do Pife — módulo único usado pelo servidor (require) e pelo navegador (<script>).
 * Ter UMA fonte da verdade evita o cliente e o servidor discordarem sobre o que é um jogo válido.
 *
 * Regras implementadas:
 *  - 2 baralhos (104 cartas, sem coringas "de verdade").
 *  - Cada jogador recebe 9 cartas. Na sua vez: compra 1 (Monte ou Lixo) e descarta 1.
 *  - Para BATER: depois de comprar (10 cartas), 9 delas formam 3 jogos de 3 cartas e a 10ª é o descarte.
 *  - Jogo = TRINCA (mesmo valor, naipes todos diferentes) ou SEQUÊNCIA (3 valores seguidos do mesmo naipe).
 *    O Ás vale 1 (A-2-3) ou 14 (Q-K-A). Não existe "dar a volta" (K-A-2 é inválido).
 *  - Curinga: o valor logo acima da carta virada ("vira"). K vira → curinga é o Ás.
 *    Um curinga substitui qualquer carta de um jogo.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.PifeRules = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const VALUES = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
    const SUITS = ['♥', '♦', '♣', '♠'];
    const NUM = {};
    VALUES.forEach((v, i) => { NUM[v] = i + 1; });
    const SUIT_NAMES = { '♥': 'copas', '♦': 'ouros', '♣': 'paus', '♠': 'espadas' };
    const VALUE_NAMES = { A: 'Ás', J: 'Valete', Q: 'Dama', K: 'Rei' };

    function nextValue(value) {
        return VALUES[(VALUES.indexOf(value) + 1) % VALUES.length];
    }

    function cardLabel(card) {
        if (!card) return '';
        return `${VALUE_NAMES[card.value] || card.value} de ${SUIT_NAMES[card.suit]}`;
    }

    // Valores que uma carta pode assumir dentro de uma sequência (o Ás vale 1 ou 14).
    function seqNumbers(value) {
        const n = NUM[value];
        return n === 1 ? [1, 14] : [n];
    }

    /** Um grupo de exatamente 3 cartas é um jogo válido? */
    function isValidSet(group, wildcardValue) {
        if (!Array.isArray(group) || group.length !== 3) return false;
        const normals = group.filter((c) => c.value !== wildcardValue);
        if (normals.length <= 1) return true; // 2 ou 3 curingas, ou 1 carta + 2 curingas

        // TRINCA: mesmo valor e naipes todos diferentes
        const sameValue = normals.every((c) => c.value === normals[0].value);
        const suits = normals.map((c) => c.suit);
        if (sameValue && new Set(suits).size === suits.length) return true;

        // SEQUÊNCIA: mesmo naipe, valores distintos e cabendo numa janela de 3 posições seguidas
        if (!normals.every((c) => c.suit === normals[0].suit)) return false;
        const values = normals.map((c) => c.value);
        if (new Set(values).size !== values.length) return false;
        for (let start = 1; start <= 12; start++) {
            const end = start + 2;
            if (normals.every((c) => seqNumbers(c.value).some((n) => n >= start && n <= end))) return true;
        }
        return false;
    }

    /** Divide as cartas (múltiplo de 3) em jogos válidos. Retorna a lista de jogos ou null. */
    function findSets(cards, wildcardValue) {
        if (cards.length === 0) return [];
        if (cards.length % 3 !== 0) return null;
        const first = cards[0];
        const rest = cards.slice(1);
        for (let i = 0; i < rest.length; i++) {
            for (let j = i + 1; j < rest.length; j++) {
                const group = [first, rest[i], rest[j]];
                if (!isValidSet(group, wildcardValue)) continue;
                const remaining = rest.filter((_, k) => k !== i && k !== j);
                const sub = findSets(remaining, wildcardValue);
                if (sub) return [group, ...sub];
            }
        }
        return null;
    }

    /**
     * Mão vencedora? Com 10 cartas, procura qual descartar para sobrarem 3 jogos.
     * Retorna { sets, discard } ou null.
     */
    function validateWin(hand, wildcardValue) {
        if (!Array.isArray(hand)) return null;
        if (hand.length === 9) {
            const sets = findSets(hand, wildcardValue);
            return sets ? { sets, discard: null } : null;
        }
        if (hand.length === 10) {
            for (let i = 0; i < hand.length; i++) {
                const rest = hand.filter((_, k) => k !== i);
                const sets = findSets(rest, wildcardValue);
                if (sets) return { sets, discard: hand[i] };
            }
        }
        return null;
    }

    /**
     * Melhor divisão possível da mão: o MAIOR número de jogos válidos disjuntos.
     * (Substitui a ordenação "gulosa", que podia esconder jogos possíveis.)
     * Retorna { groups: [[carta x3], ...], rest: [cartas soltas], count }.
     */
    function bestMelds(hand, wildcardValue) {
        const n = hand.length;
        const memo = new Map();

        function solve(mask) {
            if (memo.has(mask)) return memo.get(mask);
            let i = 0;
            while (i < n && !(mask & (1 << i))) i++;
            let best;
            if (i >= n) {
                best = { count: 0, groups: [] };
            } else {
                const without = mask & ~(1 << i);
                best = solve(without); // a carta i fica de fora
                for (let j = i + 1; j < n; j++) {
                    if (!(mask & (1 << j))) continue;
                    for (let k = j + 1; k < n; k++) {
                        if (!(mask & (1 << k))) continue;
                        if (!isValidSet([hand[i], hand[j], hand[k]], wildcardValue)) continue;
                        const sub = solve(without & ~(1 << j) & ~(1 << k));
                        if (sub.count + 1 > best.count) {
                            best = { count: sub.count + 1, groups: [[i, j, k], ...sub.groups] };
                        }
                    }
                }
            }
            memo.set(mask, best);
            return best;
        }

        const result = solve((1 << n) - 1);
        const used = new Set();
        const groups = result.groups.map((g) => g.map((idx) => { used.add(idx); return hand[idx]; }));
        const rest = hand.filter((_, idx) => !used.has(idx));
        return { groups, rest, count: groups.length };
    }

    function sortCards(cards) {
        return [...cards].sort((a, b) => {
            const sa = SUITS.indexOf(a.suit);
            const sb = SUITS.indexOf(b.suit);
            if (sa !== sb) return sa - sb;
            return NUM[a.value] - NUM[b.value];
        });
    }

    /** Embaralhamento Fisher–Yates (o antigo sort(() => Math.random() - 0.5) é enviesado). */
    function shuffle(array, randInt) {
        const rnd = randInt || ((n) => Math.floor(Math.random() * n));
        for (let i = array.length - 1; i > 0; i--) {
            const j = rnd(i + 1);
            [array[i], array[j]] = [array[j], array[i]];
        }
        return array;
    }

    /** 2 baralhos de 52 cartas, com ids únicos e estáveis (ex.: "0-4-2"). */
    function createDeck(randInt) {
        const deck = [];
        for (let d = 0; d < 2; d++) {
            SUITS.forEach((suit, si) => {
                VALUES.forEach((value, vi) => {
                    deck.push({ id: `${d}-${vi}-${si}`, value, suit });
                });
            });
        }
        return shuffle(deck, randInt);
    }

    return {
        VALUES, SUITS, NUM, SUIT_NAMES,
        nextValue, cardLabel, isValidSet, findSets, validateWin, bestMelds, sortCards, shuffle, createDeck,
    };
});
