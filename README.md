# Clube do Pife

Pife online para 2 a 4 pessoas, com salas (com senha opcional), chat, reações, contas e placar de vitórias.
Feito com Node.js, Express e Socket.IO. Funciona no celular e no computador (e dá para instalar como app).

## Como rodar

```bash
npm install
npm start          # http://localhost:3000
npm test           # regras, contas e servidor (sem rede, sem dependências extras)
```

Variáveis de ambiente:

| Variável   | Padrão   | Para quê                                                |
|------------|----------|---------------------------------------------------------|
| `PORT`     | `3000`   | Porta HTTP                                              |
| `DATA_DIR` | `./data` | Onde ficam as contas (`users.json`)                     |

> **Hospedagem:** as contas são gravadas em arquivo. Em serviços com disco temporário (ex.: plano grátis do Render/Heroku)
> o arquivo some a cada deploy/reinício. Para as contas durarem, use um disco persistente e aponte `DATA_DIR` para ele.
> As salas e partidas ficam só na memória do servidor.

## Contas e vitórias

* **Convidado (sem conta):** só escolhe um apelido. As vitórias valem **só nesta sessão** (a aba/app aberto) e são apagadas
  quando a pessoa sai. O mesmo apelido em outro aparelho é *outra* sessão e começa do zero.
  Apelidos de contas registradas são reservados, então ninguém se passa por elas.
* **Conta:** usuário + senha (sem e-mail). As vitórias ficam salvas no servidor e aparecem em qualquer aparelho.
  Quem joga como convidado pode criar uma conta e **leva junto** as vitórias da sessão.
* A contagem é sempre calculada **no servidor** (antes vinha do navegador, por isso ficava inconsistente).

## Regras implementadas

* 2 baralhos (104 cartas). Cada jogador começa com 9 cartas.
* **Curinga:** a carta virada na mesa (a "vira") define o curinga, que é o valor logo acima dela (K → Ás).
* **Jogos de 3 cartas:** *trinca* (mesmo valor, naipes diferentes) ou *sequência* (3 seguidas do mesmo naipe).
  O Ás vale 1 ou 14 (A-2-3 e Q-K-A), sem dar a volta (K-A-2 não vale).
* **Sua vez:** comprar 1 carta (Monte ou Lixo) e descartar 1. Não dá para descartar a carta que acabou de pegar do Lixo.
* **Bater:** depois de comprar (10 cartas), 9 formam 3 jogos e a 10ª é o descarte. O servidor valida.
* Se o monte acabar, o lixo é embaralhado e vira o novo monte.
* Se alguém cai, a mesa pausa por 60 s esperando a volta; depois disso a pessoa é removida e a partida continua
  (se sobrarem 2 ou mais) com as cartas dela devolvidas ao monte.
* Só o administrador (👑, quem criou a sala) inicia, reseta e expulsa.

## Organização

```
Server.js          Express + Socket.IO (cabeçalhos de segurança, arquivos estáticos)
src/hub.js         Salas, turnos, identidades, vitórias (independente de rede, testável)
src/store.js       Contas: scrypt + tokens de sessão em users.json
public/rules.js    Regras do jogo — usado pelo servidor E pelo navegador (uma única fonte da verdade)
public/client.js   Interface (sem innerHTML com dados de jogadores, sem handlers inline)
public/style.css   Layout mobile-first
public/sw.js       Service worker "rede primeiro" (nunca prende o jogador numa versão antiga)
test/              node:test — regras, contas e servidor
```

## Segurança (resumo do que foi corrigido)

* XSS: nomes, chat e avatares agora são sempre inseridos como texto; há CSP (`script-src 'self'`).
* A identidade secreta (`guestId` / token) nunca é enviada a outros jogadores; os jogadores se identificam por um `pid` público.
* Todos os eventos validam o tipo e o tamanho dos dados e são protegidos por `try/catch` (um pacote inválido não derruba o servidor).
* Limite de taxa para chat, entradas em sala e tentativas de login; senhas de conta e de sala com scrypt.
* Embaralhamento Fisher–Yates com `crypto.randomInt`.
