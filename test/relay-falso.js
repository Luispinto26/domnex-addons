// Um relay falso, para testar o Domnex Agente sem o worker. Node puro, sem
// dependências. Implementa o que o agente usa (§2 do contrato da fase 1 e
// o carteiro das cópias):
//
//   POST /agent/register                 registo com código de instalação
//   POST /agent/<uuid>/heartbeat         batimento (recado antigo + fila)
//   POST /agent/<uuid>/inventory         inventário
//   POST /agent/<uuid>/commands/<id>     resultado de um comando
//   POST /backup/<uuid>/url | /done      carteiro das cópias
//   PUT  /r2/<chave>                     o "cofre" (o PUT direto ao R2)
//
// Grava tudo o que recebe em relay.pedidos. Com estado.emBaixo = true corta
// as ligações sem responder (o curl do agente vê "000"), como um relay em
// baixo.
//
// Uso nos testes: const relay = criarRelay({ publico }); relay.servidor.listen(porta).
// `publico` é o endereço pelo qual o contentor chega aqui (para o URL do PUT).

"use strict";

const http = require("http");

const UUID = "0123456789abcdef0123456789abcdef";
const SEGREDO = "5e9c0b1d2a3f4e5d6c7b8a9f0e1d2c3b4a5f6e7d8c9b0a1f2e3d4c5b6a7f8e9d";

function estadoInicial() {
  return {
    uuid: UUID,
    segredo: SEGREDO,
    emBaixo: false,
    // A resposta ao registo (ou uma lista delas, uma por pedido). Com
    // status 0 a ligação cai sem resposta.
    registo: { status: 404, corpo: { error: "invalid_code", errorMessage: "Código de instalação desconhecido. Gera outro na consola Domnex." } },
    // Um item por batimento: o recado antigo ("restart" | "update" | null).
    recados: [],
    // Um item por batimento do agente 0.3: null (nada), um comando, uma
    // lista de comandos, ou {comandos: [...], depois() {}} — o depois()
    // corre logo a seguir a responder (para, por exemplo, "cair" o relay).
    fila: [],
    // O código com que se responde aos resultados.
    statusResultado: 200,
  };
}

function criarRelay({ publico = "http://host.docker.internal:18431" } = {}) {
  // `publico` pode mudar depois de criar (os testes só sabem a porta depois
  // de o servidor arrancar).
  const relay = { estado: estadoInicial(), pedidos: [], publico };

  relay.reiniciar = () => {
    relay.estado = estadoInicial();
    relay.pedidos.length = 0;
  };

  const json = (status, v) => ({ status, corpo: JSON.stringify(v) });

  function responder(req, caminho, texto, registo) {
    const s = relay.estado;
    let corpo = null;
    try { corpo = texto ? JSON.parse(texto) : null; } catch { corpo = undefined; }
    registo.json = corpo;

    if (req.method === "POST" && caminho === "/agent/register") {
      // Uma lista de respostas gasta-se uma por pedido; a última fica.
      const r = Array.isArray(s.registo) ? (s.registo.length > 1 ? s.registo.shift() : s.registo[0]) : s.registo;
      return json(r.status, r.corpo);
    }

    // O resto é da casa: o segredo tem de bater certo.
    const doAgente = /^\/agent\/([a-f0-9]{32})\/(heartbeat|inventory|commands\/(\d+))$/.exec(caminho);
    const doCofre = /^\/backup\/([a-f0-9]{32})\/(url|done)$/.exec(caminho);
    if ((doAgente || doCofre) && (req.headers["x-backup-secret"] !== s.segredo || (doAgente || doCofre)[1] !== s.uuid)) {
      return json(403, { error: "forbidden" });
    }

    if (req.method === "POST" && doAgente && doAgente[2] === "heartbeat") {
      const resp = { command: s.recados.length ? s.recados.shift() : null };
      let depois = null;
      if (corpo && typeof corpo.agent === "string") {
        let item = s.fila.length ? s.fila.shift() : null;
        if (item && !Array.isArray(item) && item.comandos) {
          depois = item.depois || null;
          item = item.comandos;
        }
        resp.commands = item == null ? [] : Array.isArray(item) ? item : [item];
      }
      registo.resposta = resp;
      return { ...json(200, resp), depois };
    }
    if (req.method === "POST" && doAgente && doAgente[2] === "inventory") {
      if (texto.length > 512 * 1024) return json(413, { error: "too_large" });
      if (corpo === undefined || !corpo || typeof corpo.agent !== "string") return json(400, { error: "malformed" });
      return json(200, { ok: true });
    }
    if (req.method === "POST" && doAgente && doAgente[3]) {
      return json(s.statusResultado, s.statusResultado === 200 ? { ok: true } : { error: "x" });
    }
    if (req.method === "POST" && doCofre && doCofre[2] === "url") {
      const key = `${s.uuid}/2026-09-28.tar`;
      return json(200, { url: `${relay.publico}/r2/${encodeURIComponent(key)}?assinatura=teste`, key });
    }
    if (req.method === "POST" && doCofre && doCofre[2] === "done") {
      return json(200, { ok: true });
    }
    if (req.method === "PUT" && caminho.startsWith("/r2/")) {
      return { status: 200, corpo: "" };
    }
    return json(404, { error: "not_found" });
  }

  relay.servidor = http.createServer((req, res) => {
    const partes = [];
    req.on("data", (c) => partes.push(c));
    req.on("end", () => {
      const buf = Buffer.concat(partes);
      const url = new URL(req.url, "http://relay");
      const registo = {
        t: Date.now(), metodo: req.method, caminho: url.pathname, segredo: req.headers["x-backup-secret"] || null,
        tipo: req.headers["content-type"] || null, bytes: buf.length,
        corpo: req.method === "PUT" ? null : buf.toString("utf8"),
      };
      relay.pedidos.push(registo);
      if (relay.estado.emBaixo) {
        registo.caiu = true;
        req.socket.destroy();
        return;
      }
      const r = responder(req, url.pathname, registo.corpo, registo);
      if (r.status === 0) {
        // Uma resposta que se perde depois de o relay a ter tratado (o
        // registo gasta o código mas o agente vê "000").
        registo.caiu = true;
        req.socket.destroy();
        return;
      }
      registo.status = r.status;
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(r.corpo);
      if (typeof r.depois === "function") r.depois();
    });
  });

  return relay;
}

module.exports = { criarRelay, UUID, SEGREDO };

if (require.main === module) {
  const porta = Number(process.env.PORTA || 18431);
  criarRelay({ publico: process.env.PUBLICO || `http://host.docker.internal:${porta}` })
    .servidor.listen(porta, "0.0.0.0", () => console.log(`Relay falso em :${porta} (uuid ${UUID})`));
}
