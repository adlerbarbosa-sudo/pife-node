'use strict';
/*
 * Contas de usuário (persistidas em um arquivo JSON).
 *  - Senhas com scrypt + salt (nunca em texto puro).
 *  - Sessões por token aleatório; só o hash SHA-256 do token fica salvo.
 *  - As vitórias de quem tem conta ficam aqui, então valem em qualquer aparelho.
 *
 * Sem `dir` o armazenamento fica só em memória (usado nos testes).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);

const USER_RE = /^[A-Za-z0-9_-]{3,16}$/;
const TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_TOKENS_PER_USER = 8;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

class Store {
    constructor(dir) {
        this.dir = dir || null;
        this.file = dir ? path.join(dir, 'users.json') : null;
        this.users = new Map();      // nome em minúsculas -> registro
        this.tokenIndex = new Map(); // hash do token -> nome em minúsculas
        this._timer = null;
        this._load();
    }

    /* ---------- persistência ---------- */

    _load() {
        if (!this.file) return;
        let raw;
        try {
            raw = fs.readFileSync(this.file, 'utf8');
        } catch (err) {
            if (err.code === 'ENOENT') return;
            throw err;
        }
        try {
            const data = JSON.parse(raw);
            for (const [key, user] of Object.entries(data.users || {})) {
                user.tokens = Array.isArray(user.tokens) ? user.tokens : [];
                this.users.set(key, user);
                user.tokens.forEach((t) => this.tokenIndex.set(t.h, key));
            }
        } catch (err) {
            // arquivo corrompido: guarda uma cópia em vez de perder tudo em silêncio
            const backup = `${this.file}.corrupt-${Date.now()}`;
            fs.renameSync(this.file, backup);
            console.error(`users.json ilegível; copiado para ${backup}`);
        }
    }

    _serialize() {
        const users = {};
        for (const [key, user] of this.users) users[key] = user;
        return JSON.stringify({ version: 1, users });
    }

    _save() {
        if (!this.file) return;
        clearTimeout(this._timer);
        this._timer = setTimeout(() => this.flushSync(), 200);
        if (this._timer.unref) this._timer.unref();
    }

    flushSync() {
        if (!this.file) return;
        clearTimeout(this._timer);
        try {
            fs.mkdirSync(this.dir, { recursive: true });
            const tmp = `${this.file}.tmp`;
            fs.writeFileSync(tmp, this._serialize(), { mode: 0o600 });
            fs.renameSync(tmp, this.file);
        } catch (err) {
            console.error('Falha ao salvar contas:', err.message);
        }
    }

    /* ---------- consultas ---------- */

    isNameTaken(name) {
        return typeof name === 'string' && this.users.has(name.toLowerCase());
    }

    getWins(lowerName) {
        const user = this.users.get(lowerName);
        return user ? user.wins : 0;
    }

    addWins(lowerName, n = 1) {
        const user = this.users.get(lowerName);
        if (!user || !Number.isInteger(n) || n < 1) return user ? user.wins : 0;
        user.wins += n;
        this._save();
        return user.wins;
    }

    addWin(lowerName) {
        return this.addWins(lowerName, 1);
    }

    profile(user) {
        return { name: user.name, avatar: user.avatar, wins: user.wins };
    }

    /* ---------- tokens ---------- */

    _issueToken(user) {
        const key = user.name.toLowerCase();
        const now = Date.now();
        user.tokens = user.tokens.filter((t) => {
            if (t.exp > now) return true;
            this.tokenIndex.delete(t.h);
            return false;
        });
        while (user.tokens.length >= MAX_TOKENS_PER_USER) {
            this.tokenIndex.delete(user.tokens.shift().h);
        }
        const token = crypto.randomBytes(32).toString('hex');
        const h = sha256(token);
        user.tokens.push({ h, exp: now + TOKEN_TTL_MS });
        this.tokenIndex.set(h, key);
        return token;
    }

    /* ---------- contas ---------- */

    async signup(name, password, avatar) {
        if (typeof name !== 'string' || !USER_RE.test(name)) {
            return { ok: false, error: 'Nome de usuário: 3 a 16 caracteres (letras, números, _ ou -).' };
        }
        if (typeof password !== 'string' || password.length < 6 || password.length > 64) {
            return { ok: false, error: 'A senha precisa ter de 6 a 64 caracteres.' };
        }
        const key = name.toLowerCase();
        if (this.users.has(key)) return { ok: false, error: 'Esse nome de usuário já está em uso.' };

        const salt = crypto.randomBytes(16);
        const hash = await scrypt(password, salt, 64);
        if (this.users.has(key)) return { ok: false, error: 'Esse nome de usuário já está em uso.' };

        const user = {
            name,
            avatar,
            salt: salt.toString('hex'),
            hash: hash.toString('hex'),
            wins: 0,
            createdAt: Date.now(),
            tokens: [],
        };
        this.users.set(key, user);
        const token = this._issueToken(user);
        this._save();
        return { ok: true, user: this.profile(user), token };
    }

    async login(name, password) {
        const fail = { ok: false, error: 'Usuário ou senha incorretos.' };
        if (typeof name !== 'string' || typeof password !== 'string' || password.length > 64) return fail;
        const user = this.users.get(name.toLowerCase());
        if (!user) {
            await scrypt(password, crypto.randomBytes(16), 64); // gasta o mesmo tempo
            return fail;
        }
        const derived = await scrypt(password, Buffer.from(user.salt, 'hex'), 64);
        const stored = Buffer.from(user.hash, 'hex');
        if (derived.length !== stored.length || !crypto.timingSafeEqual(derived, stored)) return fail;
        const token = this._issueToken(user);
        this._save();
        return { ok: true, user: this.profile(user), token };
    }

    resume(token) {
        if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return { ok: false };
        const key = this.tokenIndex.get(sha256(token));
        const user = key && this.users.get(key);
        if (!user) return { ok: false };
        const entry = user.tokens.find((t) => t.h === sha256(token));
        if (!entry || entry.exp < Date.now()) return { ok: false };
        return { ok: true, user: this.profile(user) };
    }

    logout(token) {
        if (typeof token !== 'string') return;
        const h = sha256(token);
        const key = this.tokenIndex.get(h);
        const user = key && this.users.get(key);
        if (!user) return;
        user.tokens = user.tokens.filter((t) => t.h !== h);
        this.tokenIndex.delete(h);
        this._save();
    }
}

module.exports = { Store, USER_RE };
