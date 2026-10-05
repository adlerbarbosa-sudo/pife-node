'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../public/rules.js');

let uid = 0;
/** "7♥ 10♠ K♦" -> cartas */
const hand = (text) => text.trim().split(/\s+/).map((tok) => {
    const suit = tok.slice(-1);
    return { id: `t${uid++}`, value: tok.slice(0, -1), suit };
});

test('nextValue: curinga é o valor acima da vira (K -> A)', () => {
    assert.equal(R.nextValue('4'), '5');
    assert.equal(R.nextValue('K'), 'A');
    assert.equal(R.nextValue('A'), '2');
});

test('trincas: naipes precisam ser todos diferentes', () => {
    assert.equal(R.isValidSet(hand('7♥ 7♦ 7♠'), 'K'), true);
    assert.equal(R.isValidSet(hand('7♥ 7♥ 7♠'), 'K'), false, 'naipe repetido (2 baralhos)');
    assert.equal(R.isValidSet(hand('7♥ 8♦ 7♠'), 'K'), false);
});

test('sequências: mesmo naipe e valores seguidos; Ás vale 1 ou 14; sem dar a volta', () => {
    assert.equal(R.isValidSet(hand('4♥ 5♥ 6♥'), 'K'), true);
    assert.equal(R.isValidSet(hand('6♥ 4♥ 5♥'), 'K'), true, 'ordem na mão não importa');
    assert.equal(R.isValidSet(hand('A♥ 2♥ 3♥'), '9'), true);
    assert.equal(R.isValidSet(hand('Q♥ K♥ A♥'), '9'), true);
    assert.equal(R.isValidSet(hand('K♥ A♥ 2♥'), '9'), false);
    assert.equal(R.isValidSet(hand('4♥ 5♦ 6♥'), 'K'), false);
    assert.equal(R.isValidSet(hand('4♥ 6♥ 7♥'), 'K'), false);
});

test('curingas substituem qualquer carta do jogo', () => {
    const w = '9';
    assert.equal(R.isValidSet(hand('4♥ 6♥ 9♣'), w), true, 'curinga no meio da sequência');
    assert.equal(R.isValidSet(hand('4♥ 5♥ 9♣'), w), true, 'curinga na ponta');
    assert.equal(R.isValidSet(hand('4♥ 7♥ 9♣'), w), false, 'buraco grande demais');
    assert.equal(R.isValidSet(hand('4♥ 4♦ 9♣'), w), true, 'trinca com curinga');
    assert.equal(R.isValidSet(hand('4♥ 4♥ 9♣'), w), false, 'duas cartas idênticas não formam jogo');
    assert.equal(R.isValidSet(hand('A♥ K♥ 9♣'), w), true, 'Q-K-A com curinga');
    assert.equal(R.isValidSet(hand('A♥ Q♥ 9♣'), w), true, 'Q-K-A com o K curinga');
    assert.equal(R.isValidSet(hand('A♥ J♥ 9♣'), w), false);
    assert.equal(R.isValidSet(hand('4♥ 9♣ 9♦'), w), true, '1 carta + 2 curingas');
    assert.equal(R.isValidSet(hand('9♣ 9♦ 9♠'), w), true, '3 curingas');
});

test('só grupos de exatamente 3 cartas', () => {
    assert.equal(R.isValidSet(hand('4♥ 5♥'), 'K'), false);
    assert.equal(R.isValidSet(hand('4♥ 5♥ 6♥ 7♥'), 'K'), false);
    assert.equal(R.isValidSet(null, 'K'), false);
});

test('validateWin: 9 cartas, 10 cartas (com descarte) e mãos inválidas', () => {
    const nine = hand('3♥ 4♥ 5♥ 7♣ 7♦ 7♠ 9♠ 10♠ J♠');
    assert.ok(R.validateWin(nine, 'K'));
    assert.equal(R.validateWin(nine, 'K').discard, null);

    const ten = hand('3♥ 4♥ 5♥ 7♣ 7♦ 7♠ 9♠ 10♠ J♠ A♣');
    const win = R.validateWin(ten, 'K');
    assert.ok(win);
    assert.equal(win.sets.length, 3);
    assert.equal(win.discard.value, 'A');

    assert.equal(R.validateWin(hand('3♥ 4♥ 5♥ 7♣ 7♦ 8♠ 9♠ 10♠ J♠ A♣'), 'K'), null);
    assert.equal(R.validateWin(hand('3♥ 4♥'), 'K'), null);
    assert.equal(R.validateWin(hand('3♥ 4♥ 5♥ 7♣ 7♦ 7♠ 9♠ 10♠ J♠ A♣ 2♣'), 'K'), null);
});

test('bestMelds acha 3 jogos mesmo onde a ordenação gulosa antiga falhava', () => {
    const h = hand('10♦ 6♥ 2♠ 8♦ 6♥ A♠ 10♥ 9♦ Q♥'); // curinga = 6
    assert.ok(R.validateWin(h, '6'));
    const m = R.bestMelds(h, '6');
    assert.equal(m.count, 3);
    assert.equal(m.rest.length, 0);
    m.groups.forEach((g) => assert.equal(R.isValidSet(g, '6'), true));
});

test('bestMelds com mão sem jogos', () => {
    const m = R.bestMelds(hand('2♥ 5♦ 9♣ J♠ K♥ 3♠'), '7');
    assert.equal(m.count, 0);
    assert.equal(m.rest.length, 6);
});

test('createDeck: 104 cartas, ids únicos, 2 de cada', () => {
    const deck = R.createDeck();
    assert.equal(deck.length, 104);
    assert.equal(new Set(deck.map((c) => c.id)).size, 104);
    const counts = {};
    deck.forEach((c) => { counts[c.value + c.suit] = (counts[c.value + c.suit] || 0) + 1; });
    assert.equal(Object.keys(counts).length, 52);
    Object.values(counts).forEach((n) => assert.equal(n, 2));
});

test('shuffle: é permutação e não tem o viés do sort(random - 0.5)', () => {
    const base = Array.from({ length: 104 }, (_, i) => i);
    const first = new Array(104).fill(0);
    const N = 20000;
    for (let n = 0; n < N; n++) {
        const s = R.shuffle([...base]);
        first[s[0]]++;
    }
    const expected = N / 104;
    const max = Math.max(...first);
    const min = Math.min(...first);
    assert.ok(max < expected * 1.6, `posição enviesada: ${max} vs esperado ${expected.toFixed(0)}`);
    assert.ok(min > expected * 0.4, `posição enviesada: ${min} vs esperado ${expected.toFixed(0)}`);
    assert.deepEqual([...R.shuffle([...base])].sort((a, b) => a - b), base);
});

test('sortCards ordena por naipe e valor', () => {
    const sorted = R.sortCards(hand('K♠ 2♥ A♥ 5♦'));
    assert.deepEqual(sorted.map((c) => c.value + c.suit), ['A♥', '2♥', '5♦', 'K♠']);
});
