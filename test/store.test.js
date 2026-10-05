'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/store.js');

test('cadastro, login e senha errada', async () => {
    const s = new Store(null);
    const r = await s.signup('Adler', 'segredo1', '🤠');
    assert.equal(r.ok, true);
    assert.equal(r.user.name, 'Adler');
    assert.equal(r.user.wins, 0);
    assert.match(r.token, /^[a-f0-9]{64}$/);

    assert.equal((await s.login('adler', 'segredo1')).ok, true, 'login ignora maiúsculas');
    assert.equal((await s.login('Adler', 'errada!!')).ok, false);
    assert.equal((await s.login('ninguem', 'segredo1')).ok, false);
});

test('validação de nome e senha; nome único sem diferenciar maiúsculas', async () => {
    const s = new Store(null);
    assert.equal((await s.signup('ab', 'segredo1', '🤠')).ok, false);
    assert.equal((await s.signup('nome com espaço', 'segredo1', '🤠')).ok, false);
    assert.equal((await s.signup('<b>x</b>', 'segredo1', '🤠')).ok, false);
    assert.equal((await s.signup('Valido', '123', '🤠')).ok, false);
    assert.equal((await s.signup('Valido', 'segredo1', '🤠')).ok, true);
    assert.equal((await s.signup('VALIDO', 'outrasenha', '🤠')).ok, false);
    assert.equal(s.isNameTaken('valido'), true);
    assert.equal(s.isNameTaken('livre'), false);
});

test('token retoma a sessão e deixa de valer após logout', async () => {
    const s = new Store(null);
    const { token } = await s.signup('Maria', 'segredo1', '🦊');
    assert.equal(s.resume(token).ok, true);
    assert.equal(s.resume(token).user.name, 'Maria');
    assert.equal(s.resume('0'.repeat(64)).ok, false);
    assert.equal(s.resume('lixo').ok, false);
    s.logout(token);
    assert.equal(s.resume(token).ok, false);
});

test('vitórias ficam na conta e sobrevivem a reiniciar o servidor', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pife-'));
    const a = new Store(dir);
    const { token } = await a.signup('Joao', 'segredo1', '😎');
    a.addWin('joao');
    a.addWin('joao');
    a.flushSync();

    const raw = fs.readFileSync(path.join(dir, 'users.json'), 'utf8');
    assert.ok(!raw.includes('segredo1'), 'senha nunca em texto puro');
    assert.ok(!raw.includes(token), 'token nunca em texto puro');

    const b = new Store(dir);
    assert.equal(b.getWins('joao'), 2);
    assert.equal(b.resume(token).ok, true, 'sessão continua válida');
    assert.equal((await b.login('JOAO', 'segredo1')).user.wins, 2, 'mesmas vitórias em outro aparelho');
    fs.rmSync(dir, { recursive: true });
});

test('arquivo corrompido vira backup em vez de apagar tudo', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pife-'));
    fs.writeFileSync(path.join(dir, 'users.json'), '{ isso não é json');
    const s = new Store(dir);
    assert.equal(s.users.size, 0);
    assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('users.json.corrupt-')));
    fs.rmSync(dir, { recursive: true });
});
