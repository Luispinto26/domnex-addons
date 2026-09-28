// Os cenários do Domnex Agente 0.3.0 (os 14 da secção G do plano da fase 1
// e os extra), corridos na imagem real do add-on, com Docker, contra um
// Supervisor + Core falso e um relay falso (os dois neste processo).
//
//   node test/cenarios.js              constrói a imagem e corre todos
//   node test/cenarios.js 6 8 10       só estes
//   node test/cenarios.js --sem-build  usa a imagem já construída
//   IMAGEM=… node test/cenarios.js --sem-build   outra imagem (uma versão antiga, para comparar)
//
// Cada cenário arranca um contentor novo da imagem com `sh /run.sh`, as
// DOMNEX_* a apontar para host.docker.internal e o batimento a 1 s, e uma
// pasta temporária montada em /data, /homeassistant e /backup. No fim diz
// PASSOU/FALHOU e as evidências (linhas do registo, pedidos gravados).

"use strict";

const { spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { isDeepStrictEqual } = require("util");
const { criarSupervisor, TOKEN } = require("./supervisor-falso");
const { criarRelay, UUID, SEGREDO } = require("./relay-falso");

const RAIZ = path.resolve(__dirname, "..");
const PASTA_ADDON = path.join(RAIZ, "domnex-agente");
const IMAGEM = process.env.IMAGEM || "domnex-agente:0.3.0-teste";
const BASE = process.env.BUILD_FROM || "ghcr.io/home-assistant/amd64-base:latest";
const HOST = process.env.HOST_DOCKER || "host.docker.internal";
const CODIGO = "INST-ABCD-EFGH";
// Os contentores e as portas são desta corrida: duas corridas ao mesmo
// tempo não se apagam os contentores uma à outra nem disputam as portas
// (por omissão o sistema escolhe portas livres).
const PREFIXO = `domnex-agente-teste-${process.pid}-`;
let PORTA_RELAY = Number(process.env.PORTA_RELAY || 0);
let PORTA_SUP = Number(process.env.PORTA_SUP || 0);

const sup = criarSupervisor();
const relay = criarRelay();

// ---------------------------------------------------------------------------
// Utilitários
// ---------------------------------------------------------------------------

function docker(args, input) {
  const r = spawnSync("docker", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, input });
  return { codigo: r.status, stdout: r.stdout || "", stderr: r.stderr || "", saida: (r.stdout || "") + (r.stderr || "") };
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

async function esperar(cond, ms, passo = 200) {
  const fim = Date.now() + ms;
  for (;;) {
    const v = cond();
    if (v || Date.now() >= fim) return v;
    await dormir(passo);
  }
}

const chaves = (o) => Object.keys(o || {}).sort().join(",");
const json = (texto) => {
  try { return JSON.parse(texto); } catch { return undefined; }
};

const naoCaiu = (p) => !p.caiu;
const batimentos = () => relay.pedidos.filter((p) => p.caminho === `/agent/${UUID}/heartbeat` && naoCaiu(p));
const inventarios = () => relay.pedidos.filter((p) => p.caminho === `/agent/${UUID}/inventory` && naoCaiu(p));
const resultados = (id) => relay.pedidos.filter((p) => p.caminho === `/agent/${UUID}/commands/${id}` && naoCaiu(p));
const pedidosSup = (metodo, caminho) => sup.pedidos.filter((p) => p.metodo === metodo && p.caminho === caminho);
const addonFalso = (slug) => sup.estado.addons.find((a) => a.slug === slug);

let contador = 0;
const casas = [];

/** Uma casa: uma pasta temporária com as opções e o core.uuid, e um
 * contentor da imagem a correr o run.sh. Com `semInodes`, o /data é um
 * tmpfs sem lugar para ficheiros novos (um disco cheio): os ficheiros de
 * `dados` e as opções são copiados para lá ao arrancar, e o que lá está lê-se
 * dentro do contentor. */
function novaCasa({ secret = SEGREDO, code = "", backups = {}, dados = {}, semInodes = false } = {}) {
  const tmp = fs.realpathSync.native(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(tmp, PREFIXO));
  const data = path.join(dir, "data");
  const conf = path.join(dir, "config");
  const backup = path.join(dir, "backup");
  fs.mkdirSync(path.join(conf, ".storage"), { recursive: true });
  fs.mkdirSync(data);
  fs.mkdirSync(backup);
  fs.writeFileSync(path.join(data, "options.json"), JSON.stringify({ secret, code }));
  fs.writeFileSync(
    path.join(conf, ".storage", "core.uuid"),
    JSON.stringify({ version: 1, minor_version: 1, key: "core.uuid", data: { uuid: UUID } }),
  );
  for (const [nome, conteudo] of Object.entries(backups)) fs.writeFileSync(path.join(backup, nome), conteudo);
  for (const [nome, conteudo] of Object.entries(dados)) fs.writeFileSync(path.join(data, nome), conteudo);

  const nome = `${PREFIXO}${++contador}`;
  // O tmpfs conta a raiz e cada ficheiro copiado: não sobra nenhum.
  const inodes = Object.keys(dados).length + 2;
  const r = docker([
    "run", "-d", "--init", "--name", nome,
    "-e", `DOMNEX_RELAY=http://${HOST}:${PORTA_RELAY}`,
    "-e", `DOMNEX_SUPERVISOR=http://${HOST}:${PORTA_SUP}`,
    "-e", "DOMNEX_TICK=1",
    "-e", `SUPERVISOR_TOKEN=${TOKEN}`,
    ...(semInodes
      ? ["--tmpfs", `/data:rw,size=1m,nr_inodes=${inodes}`, "-v", `${data}:/semente:ro`]
      : ["-v", `${data}:/data`]),
    "-v", `${conf}:/homeassistant:ro`,
    "-v", `${backup}:/backup:ro`,
    "--entrypoint", "sh", IMAGEM,
    ...(semInodes ? ["-c", "cp /semente/* /data/ && exec sh /run.sh"] : ["/run.sh"]),
  ]);
  if (r.codigo !== 0) throw new Error(`docker run falhou: ${r.saida}`);

  const casa = {
    nome,
    dir,
    registo: () => docker(["logs", nome]),
    linhas: () => docker(["logs", nome]).stdout.split("\n").filter(Boolean),
    ler: semInodes
      ? (f) => { const x = docker(["exec", nome, "cat", `/data/${f}`]); return x.codigo === 0 ? x.stdout : null; }
      : (f) => {
        try { return fs.readFileSync(path.join(data, f), "utf8"); } catch { return null; }
      },
    existe: semInodes
      ? (f) => docker(["exec", nome, "test", "-e", `/data/${f}`]).codigo === 0
      : (f) => fs.existsSync(path.join(data, f)),
    parar: () => docker(["stop", "-t", "2", nome]),
    arrancar: () => docker(["start", nome]),
    exec: (...cmd) => docker(["exec", nome, ...cmd]),
    remover: () => {
      docker(["rm", "-f", nome]);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  casas.push(casa);
  return casa;
}

function verificador() {
  const v = { falhas: [], evidencias: [] };
  v.ok = (cond, descricao) => {
    if (!cond) v.falhas.push(descricao);
    return !!cond;
  };
  v.ev = (texto) => v.evidencias.push(texto);
  // As linhas do registo que casam com um padrão, como evidência.
  v.linhas = (casa, re) => casa.linhas().filter((l) => re.test(l)).forEach((l) => v.ev(`registo: ${l}`));
  return v;
}

const rel = (t, t0) => `+${((t - t0) / 1000).toFixed(1)} s`;

// ---------------------------------------------------------------------------
// Os comandos usados nos cenários (o formato achatado que o relay entrega)
// ---------------------------------------------------------------------------

const UPDATE_MOSQUITTO = (id) => ({
  id, type: "update", entity_id: "update.mosquitto_broker_update", backup: true, to: "7.1.2",
  title: "Mosquitto broker", hassio_id: "core_mosquitto",
});

// ---------------------------------------------------------------------------
// Os cenários (1–14 os obrigatórios, 15 em diante os extra)
// ---------------------------------------------------------------------------

const cenarios = [
  {
    n: 1,
    nome: "Sem segredo, com código → regista, grava $DATA/secret, bate com esse segredo",
    async correr(v) {
      const novo = crypto.randomBytes(32).toString("hex");
      relay.estado.registo = { status: 200, corpo: { secret: novo, id: UUID, note: "Casa de Teste" } };
      relay.estado.segredo = novo;
      const casa = novaCasa({ secret: "", code: CODIGO });
      v.segredosProibidos = [novo, CODIGO];

      const bat = await esperar(() => batimentos()[0], 20000);
      v.ok(bat && bat.segredo === novo, "o primeiro batimento leva o segredo que o registo devolveu");
      const regs = relay.pedidos.filter((p) => p.caminho === "/agent/register");
      v.ok(regs.length === 1, `um só pedido de registo (houve ${regs.length})`);
      v.ok(regs[0] && isDeepStrictEqual(json(regs[0].corpo), { code: CODIGO, uuid: UUID }), "o corpo do registo é {code, uuid}");
      v.ok(regs[0] && regs[0].tipo === "application/json", "o registo vai como application/json");
      v.ok((casa.ler("secret") || "").trim() === novo, "$DATA/secret tem o segredo devolvido");
      const perm = casa.exec("stat", "-c", "%a", "/data/secret").stdout.trim();
      v.ok(perm === "600", `$DATA/secret com permissões 600 (tem ${perm})`);
      v.ok(casa.linhas().some((l) => l.endsWith("Casa registada na consola (Casa de Teste).")), "linha de registo no log");
      v.ev(`registo pedido: ${regs[0] && regs[0].corpo}`);
      v.ev(`primeiro batimento: x-backup-secret = ${bat ? bat.segredo.slice(0, 8) + "…" : "—"} (o devolvido: ${novo.slice(0, 8)}…), corpo ${bat && bat.corpo}`);
      v.ev(`$DATA/secret: ${perm}, ${((casa.ler("secret") || "").trim() === novo) ? "igual ao devolvido" : "DIFERENTE"}`);

      // Reiniciado, o agente lê o segredo de /data e não volta a registar.
      casa.parar();
      const n = batimentos().length;
      casa.arrancar();
      await esperar(() => batimentos().length >= n + 3, 20000);
      const depois = batimentos().slice(n);
      v.ok(depois.length >= 3 && depois.every((p) => p.segredo === novo), "depois de reiniciar continua a bater com o segredo de /data");
      v.ok(relay.pedidos.filter((p) => p.caminho === "/agent/register").length === 1, "não volta a registar depois de reiniciar");
      v.ok(batimentos().every((p) => p.segredo === novo), "nenhum batimento sem segredo ou com outro segredo");
      v.ev(`depois de reiniciar: ${depois.length} batimentos com o segredo de /data, 0 registos novos`);
      v.linhas(casa, /registada|a registar|arrancar/);
    },
  },
  {
    n: 2,
    nome: "Registo com 409 → uma linha no log e nenhuma tentativa a seguir",
    async correr(v) {
      const msg = "Este código de instalação já foi usado. Gera outro na consola Domnex.";
      relay.estado.registo = { status: 409, corpo: { error: "code_used", errorMessage: msg } };
      const casa = novaCasa({ secret: "", code: CODIGO });
      v.segredosProibidos = [CODIGO];
      await dormir(8000);
      const regs = relay.pedidos.filter((p) => p.caminho === "/agent/register");
      v.ok(regs.length === 1, `um só pedido de registo em 8 s de batimentos de 1 s (houve ${regs.length})`);
      const vezes = casa.linhas().filter((l) => l.includes(msg)).length;
      v.ok(vezes === 1, `o errorMessage aparece uma vez no log (${vezes})`);
      v.ok(batimentos().length === 0, "sem segredo, não há batimentos");
      v.ok(!casa.existe("secret"), "não há $DATA/secret");
      v.ev(`pedidos ao relay em 8 s: ${relay.pedidos.map((p) => `${p.metodo} ${p.caminho} → ${p.status}`).join("; ")}`);
      v.linhas(casa, /./);
    },
  },
  {
    n: 3,
    nome: "Batimento 0.3 com o corpo certo; o recado antigo restart (e update) ainda funciona",
    async correr(v) {
      relay.estado.recados = ["restart", null, null, "update"];
      // Um segredo antigo em /data/secret não pode ganhar ao das opções.
      const velho = "0".repeat(64);
      const casa = novaCasa({ dados: { secret: `${velho}\n` } });
      v.segredosProibidos = [velho];
      await esperar(() => pedidosSup("POST", "/core/update").length && batimentos().length >= 6, 20000);
      v.ok(relay.pedidos.every((p) => p.segredo !== velho), "com segredo nas opções e em /data/secret, ganha o das opções");
      const b = batimentos()[0];
      v.ok(b && isDeepStrictEqual(json(b.corpo), { version: "2026.9.3", latest: "2026.9.4", agent: "0.3.0" }),
        "corpo do batimento = {version, latest, agent}");
      v.ok(b && chaves(json(b.corpo)) === "agent,latest,version", "sem campos a mais no batimento");
      v.ok(b && b.segredo === SEGREDO && b.tipo === "application/json", "x-backup-secret e content-type certos");
      const rs = pedidosSup("POST", "/core/restart");
      v.ok(rs.length === 1 && rs[0].auth === `Bearer ${TOKEN}`, "o recado restart chegou ao Supervisor (POST /core/restart com o token)");
      v.ok(pedidosSup("POST", "/core/update").length === 1, "o recado update chegou ao Supervisor (POST /core/update)");
      const linhas = casa.linhas();
      v.ok(linhas.some((l) => l.endsWith("Reinício do Home Assistant pedido pela consola.")), "linha do recado restart");
      v.ok(linhas.length === 3, `batimentos bem-sucedidos não escrevem nada: só 3 linhas em ${batimentos().length} batimentos (${linhas.length})`);
      v.ev(`batimento: ${b && b.corpo} (x-backup-secret ${b && b.segredo === SEGREDO ? "certo" : "ERRADO"})`);
      v.ev(`resposta do relay ao 1.º batimento: ${JSON.stringify(b && b.resposta)}`);
      v.ev(`Supervisor: POST /core/restart ${rs.length}×, POST /core/update ${pedidosSup("POST", "/core/update").length}×`);
      v.ev(`${batimentos().length} batimentos, ${linhas.length} linhas no registo:`);
      linhas.forEach((l) => v.ev(`registo: ${l}`));
    },
  },
  {
    n: 4,
    nome: "Inventário: chega, é JSON válido, tem a forma da §3.1 (+ version_pending), sem opções nem títulos",
    async correr(v) {
      const casa = novaCasa();
      const inv = await esperar(() => inventarios()[0], 15000);
      v.ok(inv, "o inventário chegou ao relay");
      if (!inv) return;
      const j = json(inv.corpo);
      v.ok(j !== undefined, "é JSON válido");
      if (!j) return;
      v.ok(inv.segredo === SEGREDO && inv.tipo === "application/json", "com o segredo e como application/json");
      v.ok(chaves(j) === "addons,agent,collected_at,integrations,system,updates,usb", `chaves de topo: ${chaves(j)}`);
      v.ok(j.agent === "0.3.0" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(j.collected_at), "agent e collected_at");
      const s = j.system || {};
      v.ok(chaves(s) === "arch,core,host,ipv4,machine,os,supervisor", `chaves de system: ${chaves(s)}`);
      v.ok(isDeepStrictEqual(s.core, { version: "2026.9.3", version_latest: "2026.9.4" }), "system.core");
      v.ok(isDeepStrictEqual(s.supervisor, { version: "2026.09.2", version_latest: "2026.09.2", channel: "stable", healthy: true, supported: true }), "system.supervisor");
      v.ok(isDeepStrictEqual(s.os, { version: "18.2", version_latest: "18.3", version_pending: null, board: "rpi5-64" }), "system.os com version_pending");
      v.ok(isDeepStrictEqual(s.host, { hostname: "homeassistant", disk_total: 28.6, disk_used: 11.7, disk_free: 16.9,
        kernel: "6.12.47-haos-raspi", operating_system: "Home Assistant OS 18.2" }), "system.host (sem boot_timestamp nem o resto)");
      v.ok(s.machine === "raspberrypi5-64" && s.arch === "aarch64", "machine e arch de /info");
      v.ok(isDeepStrictEqual(s.ipv4, ["192.168.1.84/24"]), "ipv4 só da interface primária (a wlan0 tem ipv4 null)");
      const A = "name,repository,slug,state,update_available,version,version_latest";
      v.ok(Array.isArray(j.addons) && j.addons.length === 4 && j.addons.every((a) => chaves(a) === A), "addons: 4, só os 7 campos");
      v.ok(Array.isArray(j.integrations) && j.integrations.length === 5 && j.integrations.every((i) => chaves(i) === "disabled_by,domain,source,state"),
        "integrations: 5, só domain/state/source/disabled_by");
      const U = "entity_id,hassio_id,in_progress,installed_version,latest_version,platform,release_url,skipped_version,state,supported_features,title";
      v.ok(Array.isArray(j.updates) && j.updates.length === 6 && j.updates.every((u) => chaves(u) === U), "updates: 6, os 11 campos do molde");
      const core = (j.updates || []).find((u) => u.hassio_id === "core");
      v.ok(core && core.state === "on" && core.installed_version === "2026.9.3" && core.platform === "hassio", "o update do Core, do molde");
      v.ok(isDeepStrictEqual(j.usb, [
        { by_id: "/dev/serial/by-id/usb-ITead_Sonoff_Zigbee_3.0_USB_Dongle_Plus_4c1f3b0f7a2bed11-if00-port0", dev_path: "/dev/ttyUSB0",
          vendor_id: "10c4", model_id: "ea60", vendor: "ITead", model: "Sonoff_Zigbee_3.0_USB_Dongle_Plus" },
        { by_id: "/dev/serial/by-id/usb-SONOFF_SONOFF_Dongle_Plus_MG24_9a8b7c6d-if00-port0", dev_path: "/dev/ttyACM0",
          vendor_id: "10c4", model_id: "ea60", vendor: "SONOFF", model: "SONOFF_Dongle_Plus_MG24" },
      ]), "usb: as duas tty com by_id (a 2.ª pelos ID_USB_*), sem a UART nem o disco");
      // O que não pode sair da casa.
      v.ok(!inv.corpo.includes("segredo-do-mosquitto") && !inv.corpo.includes('"options"'), "sem opções de add-ons (a armadilha no /addons ficou de fora)");
      v.ok(!inv.corpo.includes("cliente.privado@exemplo.pt") && !inv.corpo.includes("Shelly da sala"), "sem títulos das integrações");
      const infos = sup.pedidos.filter((p) => /^\/addons\/[^/]+\/info$/.test(p.caminho));
      v.ok(infos.length === 0, "nunca pediu /addons/<slug>/info");
      const molde = pedidosSup("POST", "/core/api/template")[0];
      v.ok(molde && (json(molde.corpo) || {}).template && json(molde.corpo).template.includes("device_attr(dev, 'identifiers')"), "o molde da §6.1 foi ao /core/api/template");
      v.ev(`inventário: ${inv.bytes} bytes; system = ${JSON.stringify(s)}`);
      v.ev(`addons[0] = ${JSON.stringify(j.addons[0])}`);
      v.ev(`integrations[3] = ${JSON.stringify(j.integrations[3])} (o título com o email ficou em casa)`);
      v.ev(`updates[0] = ${JSON.stringify(j.updates[0])}`);
      v.ev(`usb = ${JSON.stringify(j.usb)}`);
      v.ev(`pedidos ao Supervisor: ${[...new Set(sup.pedidos.map((p) => `${p.metodo} ${p.caminho}`))].join(", ")}`);
    },
  },
  {
    n: 5,
    nome: "Inventário com o Core a responder 502 → nulls ao 3.º falhanço, não antes",
    async correr(v) {
      sup.estado.coreEmBaixo = true;
      const casa = novaCasa();
      const inv = await esperar(() => inventarios()[0], 40000);
      v.ok(inv, "o inventário acabou por chegar");
      if (!inv) return;
      const j = json(inv.corpo) || {};
      const tent = pedidosSup("GET", "/core/api/config/config_entries/entry");
      const antes = tent.filter((p) => p.t <= inv.t);
      v.ok(antes.length === 3, `3 tentativas ao Core antes de mandar (${antes.length})`);
      v.ok(antes.every((p) => p.status === 502), "as três deram 502");
      v.ok(inventarios().filter((p) => antes[2] && p.t < antes[2].t).length === 0, "nenhum inventário antes da 3.ª falha");
      v.ok(j.integrations === null && j.updates === null, "integrations e updates a null");
      v.ok(j.system && j.system.core && j.system.core.version === "2026.9.3" && Array.isArray(j.addons) && j.addons.length === 4,
        "o resto do inventário vai inteiro");
      const bats = batimentos();
      const entre = (a, b) => bats.filter((p) => p.t > a.t && p.t < b.t).length;
      if (antes.length === 3) {
        v.ok(entre(antes[0], antes[1]) >= 4 && entre(antes[1], antes[2]) >= 4, "as tentativas vêm de 5 em 5 batimentos");
        v.ev(`tentativas ao Core (502): ${antes.map((p) => rel(p.t, antes[0].t)).join(", ")}; batimentos entre elas: ${entre(antes[0], antes[1])}, ${entre(antes[1], antes[2])}`);
      }
      v.ev(`inventário entregue a ${rel(inv.t, antes[0] ? antes[0].t : inv.t)}: integrations=${JSON.stringify(j.integrations)}, updates=${JSON.stringify(j.updates)}, system.core=${JSON.stringify(j.system && j.system.core)}`);
      v.ok(casa.linhas().some((l) => l.includes("O Core não respondeu (3 vezes seguidas)")), "uma linha no log a dizer que vai sem o Core");
      v.linhas(casa, /Core não respondeu/);
    },
  },
  {
    n: 6,
    nome: "update de um add-on: pré-verificação, install, confirmação pelo /addons, resultado, inventário a seguir",
    async correr(v) {
      sup.estado.aoInstalar = async (corpo) => {
        if (corpo.entity_id === "update.mosquitto_broker_update") {
          await dormir(1500);
          addonFalso("core_mosquitto").version = "7.1.2";
        }
        return null;
      };
      relay.estado.fila = [null, UPDATE_MOSQUITTO(21)];
      const casa = novaCasa();
      const res = await esperar(() => resultados(21)[0], 30000);
      v.ok(res, "o resultado chegou ao relay");
      if (!res) return;
      const invDepois = await esperar(() => inventarios().find((p) => p.t > res.t), 10000);
      const estado = pedidosSup("GET", "/core/api/states/update.mosquitto_broker_update")[0];
      const install = pedidosSup("POST", "/core/api/services/update/install")[0];
      const addons = sup.pedidos.find((p) => p.metodo === "GET" && p.caminho === "/addons" && install && p.t >= install.t);
      v.ok(estado && install && estado.t <= install.t, "leu o estado da entidade antes do install");
      v.ok(install && isDeepStrictEqual(json(install.corpo), { entity_id: "update.mosquitto_broker_update", backup: true }), "install com {entity_id, backup: true}");
      v.ok(addons && addons.t <= res.t, "confirmou pelo GET /addons depois do install");
      v.ok(isDeepStrictEqual(json(res.corpo), { ok: true, message: "Instalado 7.1.2.", installed_version: "7.1.2" }), "resultado ok com a versão");
      const ji = invDepois && json(invDepois.corpo);
      v.ok(ji && ji.addons.find((a) => a.slug === "core_mosquitto").version === "7.1.2", "inventário a seguir ao resultado, já com 7.1.2");
      v.ok(!casa.existe("command.json") && !casa.existe("result.json"), "command.json e result.json apagados");
      const t0 = estado ? estado.t : res.t;
      v.ev(`Supervisor: GET states ${rel(estado.t, t0)} → POST install ${rel(install.t, t0)} ${install.corpo} → GET /addons ${rel(addons.t, t0)}`);
      v.ev(`relay: resultado ${rel(res.t, t0)} ${res.corpo}; inventário ${invDepois ? rel(invDepois.t, t0) : "—"} (core_mosquitto ${ji ? ji.addons.find((a) => a.slug === "core_mosquitto").version : "—"})`);
      v.linhas(casa, /Comando #21/);
    },
  },
  {
    n: 7,
    nome: "update com a entidade unavailable → falha sem chamar o install",
    async correr(v) {
      sup.estado.indisponiveis.add("update.shelly_sala_firmware");
      relay.estado.fila = [null, { id: 31, type: "update", entity_id: "update.shelly_sala_firmware", backup: false, to: "1.7.6", title: "Shelly Sala" }];
      const casa = novaCasa();
      const res = await esperar(() => resultados(31)[0], 20000);
      const r = res && json(res.corpo);
      v.ok(r && r.ok === false && /indisponível/.test(r.message) && r.installed_version === null, "falhou a dizer que está indisponível");
      v.ok(pedidosSup("GET", "/core/api/states/update.shelly_sala_firmware").length === 1, "leu o estado da entidade");
      v.ok(pedidosSup("POST", "/core/api/services/update/install").length === 0, "não chamou o install");
      v.ev(`resultado: ${res && res.corpo}`);
      v.ev(`POST /core/api/services/update/install: ${pedidosSup("POST", "/core/api/services/update/install").length} pedidos`);
      v.linhas(casa, /Comando #31/);
    },
  },
  {
    n: 8,
    nome: "update do Core com 502 no install e a versão nova a correr 30 s depois → ok, só quando o Supervisor acabou",
    async correr(v) {
      const tempos = [];
      sup.estado.aoInstalar = async (corpo) => {
        if (corpo.entity_id !== "update.home_assistant_core_update") return null;
        const s = sup.estado;
        // A ordem do Supervisor (homeassistant/core.py, update()): puxa a
        // imagem, pára o Core antigo e regista logo a versão nova — o
        // /core/info já diz 2026.9.4 com o Core em baixo —, arranca o novo,
        // espera que fique RUNNING, verifica-o (e volta à anterior se falhar),
        // e só então acaba o trabalho home_assistant_core_update. O Core que
        // atendia o install morre a meio: 502.
        const trabalho = sup.novoTrabalho("home_assistant_core_update");
        s.coreEmBaixo = true;
        s.core.version = "2026.9.4";
        tempos.push(setTimeout(() => { s.coreEmBaixo = false; }, 30000));
        tempos.push(setTimeout(() => { trabalho.done = true; trabalho.progress = 100; }, 45000));
        return { status: 502, tipo: "text/plain; charset=utf-8", corpo: "502: Bad Gateway" };
      };
      relay.estado.fila = [null, { id: 41, type: "update", entity_id: "update.home_assistant_core_update", backup: true, to: "2026.9.4",
        title: "Home Assistant Core", hassio_id: "core" }];
      const casa = novaCasa();
      const res = await esperar(() => resultados(41)[0], 120000, 500);
      tempos.forEach(clearTimeout);
      v.ok(res, "o resultado chegou ao relay");
      if (!res) return;
      const install = pedidosSup("POST", "/core/api/services/update/install");
      v.ok(install.length === 1 && install[0].status === 502, "um só install, respondido com 502");
      v.ok(install[0] && isDeepStrictEqual(json(install[0].corpo), { entity_id: "update.home_assistant_core_update", backup: true }), "install com backup");
      v.ok(isDeepStrictEqual(json(res.corpo), { ok: true, message: "Instalado 2026.9.4.", installed_version: "2026.9.4" }), "resultado ok na 2026.9.4");
      v.ok(resultados(41).length === 1, "um só resultado");
      v.ok(res.t - install[0].t >= 45000,
        `o ok só chegou com o Core novo a correr e o trabalho do Supervisor acabado (≥ 45 s; foi a ${rel(res.t, install[0].t)})`);
      const t0 = install[0].t;
      const cfg = pedidosSup("GET", "/core/api/config").filter((p) => p.t >= t0 && p.t <= res.t);
      const trab = pedidosSup("GET", "/jobs/info").filter((p) => p.t >= t0 && p.t <= res.t);
      v.ev(`install +0.0 s → 502 (o /core/info já diz 2026.9.4); Core novo a correr a +30.0 s; trabalho do Supervisor acabado a +45.0 s; resultado a ${rel(res.t, t0)}: ${res.corpo}`);
      v.ev(`confirmação: GET /core/api/config ${cfg.map((p) => `${rel(p.t, t0)}→${p.status}`).join(", ") || "—"}; GET /jobs/info ${trab.map((p) => rel(p.t, t0)).join(", ") || "—"}`);
      v.linhas(casa, /Comando #41/);
    },
  },
  {
    n: 9,
    nome: "update do OS → ok com a mensagem de reinício pendente (via version_pending)",
    async correr(v) {
      sup.estado.aoInstalar = async (corpo) => {
        if (corpo.entity_id === "update.home_assistant_operating_system_update") sup.estado.os.version_pending = "18.3";
        return null;
      };
      relay.estado.fila = [null, { id: 51, type: "update", entity_id: "update.home_assistant_operating_system_update", backup: false,
        to: "18.3", title: "Home Assistant Operating System", hassio_id: "OS" }];
      const casa = novaCasa();
      const res = await esperar(() => resultados(51)[0], 30000);
      v.ok(res && isDeepStrictEqual(json(res.corpo), {
        ok: true,
        message: "Instalado 18.3 — o Pi precisa de reiniciar para ficar nessa versão (usa Reiniciar o Pi).",
        installed_version: "18.3",
      }), "ok com a mensagem de reinício pendente");
      const install = pedidosSup("POST", "/core/api/services/update/install")[0];
      v.ok(install && isDeepStrictEqual(json(install.corpo), { entity_id: "update.home_assistant_operating_system_update" }), "install sem backup (backup: false)");
      v.ok(pedidosSup("POST", "/host/reboot").length === 0, "o agente não reiniciou o Pi por iniciativa própria");
      v.ev(`resultado: ${res && res.corpo}`);
      v.ev(`POST /host/reboot: ${pedidosSup("POST", "/host/reboot").length} pedidos; /os/info depois do install: version ${sup.estado.os.version}, version_pending ${sup.estado.os.version_pending}`);
      v.linhas(casa, /Comando #51/);
    },
  },
  {
    n: 10,
    nome: "reboot + retoma: o contentor pára a meio e volta; o resultado sai com o boot_timestamp posterior",
    async correr(v) {
      relay.estado.fila = [null, { id: 61, type: "reboot" }];
      const casa = novaCasa();
      const reboot = await esperar(() => pedidosSup("POST", "/host/reboot")[0], 20000);
      v.ok(reboot, "pediu POST /host/reboot");
      if (!reboot) return;
      await dormir(1000);
      const emCurso = json(casa.ler("command.json") || "");
      v.ok(emCurso && emCurso.id === 61 && emCurso.type === "reboot" && Number.isInteger(emCurso.started_at), "command.json gravado com started_at");
      v.ok(resultados(61).length === 0, "sem resultado enquanto o arranque é o de antes do pedido");
      v.ev(`command.json antes de parar: ${(casa.ler("command.json") || "").trim()}`);
      // O Pi "reinicia": o contentor morre, o arranque passa a ser 2 s depois
      // do pedido (no relógio do contentor), e o contentor volta.
      casa.parar();
      sup.estado.host.boot_timestamp = ((emCurso ? emCurso.started_at : 0) + 2) * 1e6;
      casa.arrancar();
      const res = await esperar(() => resultados(61)[0], 30000);
      v.ok(res && isDeepStrictEqual(json(res.corpo), { ok: true, message: "O Pi reiniciou.", installed_version: null }), "resultado ok: O Pi reiniciou.");
      v.ok(pedidosSup("POST", "/host/reboot").length === 1, "a retoma não voltou a pedir o reboot");
      v.ok(casa.linhas().some((l) => l.includes("A retomar o comando #61 (reboot)")), "linha da retoma no log");
      v.ok(!casa.existe("command.json"), "command.json apagado");
      v.ev(`boot_timestamp novo: ${sup.estado.host.boot_timestamp} µs > started_at × 10⁶ = ${emCurso && emCurso.started_at * 1e6}`);
      v.ev(`resultado: ${res && res.corpo}; POST /host/reboot: ${pedidosSup("POST", "/host/reboot").length}×`);
      v.linhas(casa, /#61|arrancar/);
    },
  },
  {
    n: 11,
    nome: "Um segundo comando enquanto um corre → \"outro comando em curso\"",
    async correr(v) {
      sup.estado.aoInstalar = async (corpo) => {
        if (corpo.entity_id === "update.mosquitto_broker_update") {
          // O proxy do Supervisor desiste com 502 (aos 300 s; aqui aos 8 s) e
          // o add-on só acaba de atualizar 4 s depois: o agente tem de o ver
          // numa volta seguinte da confirmação pelo /addons, de 20 em 20 s.
          await dormir(8000);
          setTimeout(() => { addonFalso("core_mosquitto").version = "7.1.2"; }, 4000);
          return { status: 502, tipo: "text/plain; charset=utf-8", corpo: "502: Bad Gateway" };
        }
        return null;
      };
      relay.estado.fila = [null, UPDATE_MOSQUITTO(71), null, { id: 72, type: "restart" }];
      const casa = novaCasa();
      const b = await esperar(() => resultados(72)[0], 20000);
      const a = await esperar(() => resultados(71)[0], 50000, 500);
      const rb = b && json(b.corpo);
      v.ok(rb && rb.ok === false && rb.message === "Outro comando em curso (#71); este não foi executado.", "o segundo foi recusado");
      v.ok(a && b && b.t < a.t, "a recusa chegou antes do fim do primeiro");
      v.ok(a && isDeepStrictEqual(json(a.corpo), { ok: true, message: "Instalado 7.1.2.", installed_version: "7.1.2" }), "o primeiro acabou bem");
      v.ok(pedidosSup("POST", "/core/restart").length === 0, "o restart recusado não chegou ao Supervisor");
      const install = pedidosSup("POST", "/core/api/services/update/install")[0];
      const voltas = sup.pedidos.filter((p) => p.metodo === "GET" && p.caminho === "/addons" && install && a && p.t > install.t && p.t <= a.t);
      v.ok(voltas.length >= 2 && voltas[voltas.length - 1].t - voltas[voltas.length - 2].t >= 19000,
        `confirmou pelo /addons em mais de uma volta, de 20 em 20 s (${voltas.length} voltas)`);
      v.ev(`#72: ${b && b.corpo}`);
      v.ev(`#71: ${a && a.corpo} (${a && b ? rel(a.t, b.t) : "—"} depois da recusa); GET /addons depois do install: ${install ? voltas.map((p) => rel(p.t, install.t)).join(", ") : "—"}`);
      v.linhas(casa, /Comando #7[12]/);
    },
  },
  {
    n: 12,
    nome: "O resultado não entregue (relay em baixo) fica em $DATA/result.json e sai no batimento seguinte",
    async correr(v) {
      sup.estado.atrasoAddonMs = 2000;
      relay.estado.fila = [null, {
        comandos: [{ id: 81, type: "addon_restart", slug: "core_nginx_proxy", title: "NGINX Home Assistant SSL proxy" }],
        // O relay cai logo a seguir a entregar o comando.
        depois() { relay.estado.emBaixo = true; },
      }];
      const casa = novaCasa();
      const guardado = await esperar(() => casa.ler("result.json"), 20000);
      v.ok(guardado, "o resultado ficou em $DATA/result.json");
      const caidos = () => relay.pedidos.filter((p) => p.caminho === `/agent/${UUID}/commands/81` && p.caiu);
      await esperar(() => caidos().length >= 3, 15000);
      v.ok(caidos().length >= 3 && casa.existe("result.json"), `tentou entregar ${caidos().length}× sem resposta e o ficheiro continua lá`);
      v.ok(resultados(81).length === 0, "nada entregue enquanto o relay está em baixo");
      v.ev(`$DATA/result.json com o relay em baixo: ${(guardado || "").trim()}`);
      v.ev(`tentativas sem resposta: ${caidos().length}`);
      relay.estado.emBaixo = false;
      const tVolta = Date.now();
      const res = await esperar(() => resultados(81)[0], 10000);
      v.ok(res && isDeepStrictEqual(json(res.corpo), { ok: true, message: "Add-on NGINX Home Assistant SSL proxy reiniciado.", installed_version: null }),
        "entregue quando o relay voltou");
      await esperar(() => !casa.existe("result.json"), 5000);
      v.ok(!casa.existe("result.json"), "result.json apagado depois do 200");
      v.ok(pedidosSup("POST", "/addons/core_nginx_proxy/restart").length === 1, "o add-on foi reiniciado uma vez");
      const avisos = casa.linhas().filter((l) => l.includes("O resultado do comando #81 não foi entregue")).length;
      v.ok(avisos === 1, `o aviso de não entregue aparece uma vez, não a cada batimento (${avisos})`);
      v.ev(`relay de volta; resultado entregue ${res ? rel(res.t, tVolta) : "—"} depois: ${res && res.corpo}`);
      v.linhas(casa, /#81/);
    },
  },
  {
    n: 13,
    nome: "O carteiro das cópias continua a entregar uma cópia (url → PUT → done), uma vez só",
    async correr(v) {
      const nome = "automatic_backup_2026_09_28_03_00.tar";
      const casa = novaCasa({ backups: { "5a1b2c3d.tar": Buffer.alloc(100, 1), [nome]: Buffer.alloc(4096, 7) } });
      const done = await esperar(() => relay.pedidos.find((p) => p.caminho === `/backup/${UUID}/done`), 20000);
      const url = relay.pedidos.find((p) => p.caminho === `/backup/${UUID}/url`);
      const put = relay.pedidos.find((p) => p.metodo === "PUT");
      v.ok(url && url.segredo === SEGREDO, "pediu o URL com o segredo");
      v.ok(put && put.bytes === 4096 && put.caminho.startsWith("/r2/"), "PUT da cópia automática (4096 bytes), não do parcial");
      v.ok(done && isDeepStrictEqual(json(done.corpo), { key: `${UUID}/2026-09-28.tar` }) && done.segredo === SEGREDO, "confirmou com {key}");
      v.ok(casa.linhas().some((l) => l.endsWith(`Cópia entregue: ${nome}`)), "linha \"Cópia entregue\" no log");
      v.ok((casa.ler("last_uploaded") || "").startsWith(`/backup/${nome} `), "a marca ficou em $DATA/last_uploaded");
      v.ev(`relay: POST /backup/<uuid>/url → PUT ${put && put.caminho} (${put && put.bytes} bytes) → POST /done ${done && done.corpo}`);
      v.ev(`$DATA/last_uploaded: ${(casa.ler("last_uploaded") || "").trim()}`);
      // A passagem seguinte (batimento 30) vê a mesma marca e não reenvia.
      await esperar(() => batimentos().length >= 33, 60000, 500);
      const puts = relay.pedidos.filter((p) => p.metodo === "PUT").length;
      v.ok(batimentos().length >= 33 && puts === 1, `na passagem seguinte (batimento 30) não reenvia (${puts} PUT em ${batimentos().length} batimentos)`);
      v.linhas(casa, /Cópia/);
    },
  },
  {
    n: 14,
    nome: "sh -n e dash -n limpos; nenhum \\r nos ficheiros do add-on",
    async correr(v) {
      const sh = docker(["run", "--rm", "--entrypoint", "sh", IMAGEM, "-c", "sh -n /run.sh && echo sh-n-ok"]);
      v.ok(sh.codigo === 0 && sh.stdout.includes("sh-n-ok") && !sh.stderr.trim(), `sh -n /run.sh (busybox ash da imagem): ${sh.saida.trim()}`);
      const dash = docker(["run", "--rm", "--entrypoint", "sh", IMAGEM, "-c",
        "apk add --no-cache dash >/dev/null 2>&1 || { echo sem-rede-para-o-dash; exit 3; }; dash -n /run.sh && echo dash-n-ok"]);
      v.ok(dash.codigo === 0 && dash.stdout.includes("dash-n-ok") && !dash.stderr.trim(), `dash -n /run.sh: ${dash.saida.trim()}`);
      const ficheiros = [];
      (function andar(d) {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) andar(p);
          else if (!/\.png$/.test(e.name)) ficheiros.push(p);
        }
      })(PASTA_ADDON);
      const comCR = ficheiros.filter((f) => fs.readFileSync(f).includes(13));
      v.ok(comCR.length === 0, `sem \\r: ${comCR.length ? comCR.join(", ") : "nenhum ficheiro com \\r"}`);
      v.ev(`ficheiros verificados: ${ficheiros.map((f) => path.relative(RAIZ, f).replace(/\\/g, "/")).join(", ")}`);
      const naImagem = docker(["run", "--rm", "--entrypoint", "sh", IMAGEM, "-c", "grep -c \"$(printf '\\r')\" /run.sh; head -1 /run.sh"]);
      v.ev(`na imagem: grep -c '\\r' /run.sh → ${naImagem.stdout.trim().replace(/\n/, "; shebang ")}`);
      v.ok(naImagem.stdout.trim().startsWith("0"), "o /run.sh da imagem também não tem \\r");
    },
  },

  // Extras: caminhos do plano que os 14 não cobrem.
  {
    n: 15,
    nome: "(extra) Registo com 503, 429 e 403 (de um proxy) → tenta no batimento seguinte, uma linha por tipo de falha; depois regista",
    async correr(v) {
      const novo = crypto.randomBytes(32).toString("hex");
      relay.estado.registo = [
        { status: 503, corpo: { error: "unavailable", errorMessage: "Serviço indisponível." } },
        { status: 429, corpo: { error: "too_many_attempts", errorMessage: "Demasiadas tentativas falhadas. O agente volta a tentar mais tarde." } },
        { status: 429, corpo: { error: "too_many_attempts", errorMessage: "Demasiadas tentativas falhadas. O agente volta a tentar mais tarde." } },
        // Um 403 que não é do relay (uma firewall, um portal de hotel): o
        // código não tem culpa, e não se desiste dele.
        { status: 403, corpo: { error: "forbidden" } },
        { status: 200, corpo: { secret: novo, id: UUID, note: null } },
      ];
      relay.estado.segredo = novo;
      const casa = novaCasa({ secret: "", code: CODIGO });
      v.segredosProibidos = [novo, CODIGO];
      const bat = await esperar(() => batimentos()[0], 20000);
      const regs = relay.pedidos.filter((p) => p.caminho === "/agent/register");
      v.ok(regs.length === 5, `5 pedidos de registo, um por batimento (${regs.length})`);
      v.ok(regs.length >= 2 && regs[1].t - regs[0].t >= 800, "um por batimento, não em rajada");
      v.ok(bat && bat.segredo === novo, "registou à 5.ª e bate com o segredo novo");
      const linhas = casa.linhas();
      v.ok(linhas.filter((l) => l.includes("O registo não passou (503")).length === 1, "uma linha para o 503");
      v.ok(linhas.filter((l) => l.includes("O registo não passou (429")).length === 1, "uma linha para os dois 429");
      v.ok(linhas.filter((l) => l.includes("O registo não passou (403")).length === 1, "uma linha para o 403, que não pára o registo");
      v.ok(!linhas.some((l) => l.includes("Registo recusado")), "nenhum \"Registo recusado\"");
      v.ok(linhas.some((l) => l.endsWith("Casa registada na consola.")), "registada (sem nome)");
      v.ev(`registo: ${regs.map((p) => `${rel(p.t, regs[0].t)} → ${p.status}`).join(", ")}`);
      v.linhas(casa, /regist/);
    },
  },
  {
    n: 16,
    nome: "(extra) update sem hassio_id (firmware) → confirma pelo estado da entidade, de 20 em 20 s",
    async correr(v) {
      sup.estado.aoInstalar = async (corpo) => {
        if (corpo.entity_id === "update.shelly_sala_firmware") {
          // O firmware só aparece instalado 5 s depois de o serviço acabar.
          const u = sup.estado.updates["update.shelly_sala_firmware"];
          setTimeout(() => { u.installed_version = "1.7.6"; }, 5000);
        }
        return null;
      };
      relay.estado.fila = [null, { id: 91, type: "update", entity_id: "update.shelly_sala_firmware", backup: false, to: "1.7.6", title: "Shelly Sala" }];
      const casa = novaCasa();
      const res = await esperar(() => resultados(91)[0], 40000, 500);
      const install = pedidosSup("POST", "/core/api/services/update/install")[0];
      const leituras = pedidosSup("GET", "/core/api/states/update.shelly_sala_firmware");
      v.ok(res && isDeepStrictEqual(json(res.corpo), { ok: true, message: "Instalado 1.7.6.", installed_version: "1.7.6" }), "ok pela entidade");
      const depois = leituras.filter((p) => install && p.t >= install.t);
      v.ok(depois.length === 2 && depois[1].t - depois[0].t >= 19000, `confirmou pela entidade: ${depois.length} leituras depois do install, 20 s entre elas`);
      v.ok(!sup.pedidos.some((p) => p.caminho === "/addons" && install && p.t > install.t && res && p.t < res.t), "sem hassio_id, não foi ao /addons");
      v.ev(`install ${install ? "+0.0 s" : "—"}; leituras da entidade depois: ${depois.map((p) => rel(p.t, install.t)).join(", ")}; resultado ${res ? rel(res.t, install.t) : "—"}: ${res && res.corpo}`);
      v.linhas(casa, /#91/);
    },
  },
  {
    n: 17,
    nome: "(extra) install recusado com 500 e mensagem → falha já, com a mensagem",
    async correr(v) {
      const msg = "Backup is not supported for update.home_assistant_supervisor_update.";
      sup.estado.supervisor.version_latest = "2026.09.3";
      sup.estado.aoInstalar = async () => ({ status: 500, tipo: "application/json", corpo: JSON.stringify({ message: msg }) });
      relay.estado.fila = [null, { id: 95, type: "update", entity_id: "update.home_assistant_supervisor_update", backup: true, to: "2026.09.3",
        title: "Home Assistant Supervisor", hassio_id: "supervisor" }];
      const casa = novaCasa();
      const res = await esperar(() => resultados(95)[0], 20000);
      const install = pedidosSup("POST", "/core/api/services/update/install")[0];
      v.ok(res && isDeepStrictEqual(json(res.corpo), { ok: false, message: `O Home Assistant recusou atualizar Home Assistant Supervisor (500: ${msg}).`, installed_version: null }),
        "falhou com a mensagem do Core");
      v.ok(res && install && res.t - install.t < 5000, "sem esperar pela confirmação");
      v.ev(`resultado ${res && install ? rel(res.t, install.t) : "—"} depois do install: ${res && res.corpo}`);
      v.linhas(casa, /#95/);
    },
  },
  {
    n: 18,
    nome: "(extra) update do Core que o Supervisor desfaz (a nova arranca, falha a verificação, volta à anterior) → nunca dá ok; no fim do prazo falha com a versão em que ficou",
    async correr(v) {
      const s = sup.estado;
      // O agente reiniciou a meio do update (retoma) e faltam 70 s para os
      // 45 min: o cenário chega ao fim do prazo em pouco mais de um minuto.
      const agora = Math.floor(Date.now() / 1000);
      const cmd = { id: 42, type: "update", entity_id: "update.home_assistant_core_update", backup: true, to: "2026.9.4",
        title: "Home Assistant Core", hassio_id: "core", started_at: agora - 2700 + 70 };
      // O Supervisor já parou o Core antigo e registou a versão nova.
      const trabalho = sup.novoTrabalho("home_assistant_core_update");
      s.core.version = "2026.9.4";
      s.coreEmBaixo = true;
      const t0 = Date.now();
      const tempos = [
        // +5 s: o Core novo arranca e responde; o Supervisor verifica-o.
        setTimeout(() => { s.coreEmBaixo = false; }, 5000),
        // +45 s: a verificação falhou — volta à 2026.9.3 (o Core pára outra vez).
        setTimeout(() => { s.coreEmBaixo = true; s.core.version = "2026.9.3"; }, 45000),
        // +55 s: o Core antigo de volta; o trabalho acaba.
        setTimeout(() => { s.coreEmBaixo = false; trabalho.done = true; trabalho.progress = 100; }, 55000),
      ];
      const casa = novaCasa({ dados: { "command.json": JSON.stringify(cmd) } });
      const res = await esperar(() => resultados(42)[0], 120000, 500);
      tempos.forEach(clearTimeout);
      v.ok(res, "o resultado chegou ao relay");
      if (!res) return;
      v.ok(resultados(42).every((p) => (json(p.corpo) || {}).ok === false), "nunca houve um ok");
      v.ok(isDeepStrictEqual(json(res.corpo), {
        ok: false, message: "O Core não voltou na versão 2026.9.4 ao fim de 45 min — ficou na 2026.9.3.", installed_version: "2026.9.3",
      }), "falhou a dizer em que versão ficou");
      v.ok(res.t - t0 >= 60000, `só no fim do prazo (${rel(res.t, t0)})`);
      v.ok(pedidosSup("POST", "/core/api/services/update/install").length === 0, "a retoma não voltou a pedir o install");
      v.ok(casa.linhas().some((l) => l.includes("A retomar o comando #42 (update)")), "linha da retoma no log");
      const novo = pedidosSup("GET", "/core/api/config").filter((p) => p.status === 200 && p.t - t0 < 45000);
      v.ev(`o Core novo (2026.9.4) respondeu ao /core/api/config ${novo.length}× (${novo.map((p) => rel(p.t, t0)).join(", ")}) com o trabalho do Supervisor por acabar — sem ok`);
      v.ev(`resultado a ${rel(res.t, t0)}: ${res.corpo}`);
      v.linhas(casa, /#42/);
    },
  },
  {
    n: 19,
    nome: "(extra) Relay em baixo desde o arranque → o inventário não se recolhe a cada batimento falhado; sai quando o relay volta",
    async correr(v) {
      relay.estado.emBaixo = true;
      const casa = novaCasa();
      const caidos = () => relay.pedidos.filter((p) => p.caiu && p.caminho === `/agent/${UUID}/heartbeat`).length;
      await esperar(() => caidos() >= 6, 20000);
      const moldes = pedidosSup("POST", "/core/api/template").length;
      const hw = pedidosSup("GET", "/hardware/info").length;
      v.ok(moldes === 0 && hw === 0, `sem batimento, nenhuma recolha (${moldes} moldes e ${hw} GET /hardware/info em ${caidos()} batimentos falhados)`);
      relay.estado.emBaixo = false;
      const inv = await esperar(() => inventarios()[0], 10000);
      v.ok(inv, "o inventário saiu quando o relay voltou");
      v.ok(pedidosSup("POST", "/core/api/template").length === 1, "recolhido uma vez só");
      v.ev(`relay em baixo: ${caidos()} batimentos falhados, ${moldes} recolhas; relay de volta: inventário ${inv ? "entregue" : "—"}, ${pedidosSup("POST", "/core/api/template").length} recolha`);
    },
  },
  {
    n: 20,
    nome: "(extra) install respondido com 503 (o Core estava a parar e não o aceitou) → falha já, sem 45 min de espera",
    async correr(v) {
      sup.estado.aoInstalar = async () => ({ status: 503, tipo: "text/plain; charset=utf-8", corpo: "" });
      relay.estado.fila = [null, UPDATE_MOSQUITTO(96)];
      const casa = novaCasa();
      const res = await esperar(() => resultados(96)[0], 20000);
      const install = pedidosSup("POST", "/core/api/services/update/install")[0];
      v.ok(res && isDeepStrictEqual(json(res.corpo), {
        ok: false, message: "O Home Assistant estava a parar e não aceitou o pedido (503); a atualização de Mosquitto broker não foi pedida.",
        installed_version: null,
      }), "falhou a dizer que não foi pedida");
      v.ok(res && install && res.t - install.t < 5000, "sem esperar pela confirmação");
      v.ok(!casa.existe("command.json"), "o comando não ficou em curso");
      v.ev(`resultado ${res && install ? rel(res.t, install.t) : "—"} depois do install: ${res && res.corpo}`);
      v.linhas(casa, /#96/);
    },
  },
  {
    n: 21,
    nome: "(extra) update pedido para uma versão que já não é a disponível (inventário antigo) → falha sem chamar o install",
    async correr(v) {
      addonFalso("core_mosquitto").version_latest = "7.1.3";
      relay.estado.fila = [null, UPDATE_MOSQUITTO(97)];
      const casa = novaCasa();
      const res = await esperar(() => resultados(97)[0], 20000);
      v.ok(res && isDeepStrictEqual(json(res.corpo), {
        ok: false, message: "A versão disponível de Mosquitto broker mudou para 7.1.3 (o pedido era a 7.1.2); a atualização não foi pedida — pede outra vez.",
        installed_version: null,
      }), "falhou a dizer a versão disponível");
      v.ok(pedidosSup("POST", "/core/api/services/update/install").length === 0, "não chamou o install");
      v.ok(!casa.existe("command.json"), "o comando não ficou em curso");
      v.ev(`resultado: ${res && res.corpo}`);
      v.linhas(casa, /#97/);
    },
  },
  {
    n: 22,
    nome: "(extra) O agente parou entre gravar o resultado e apagar o command.json → entrega esse resultado, sem o reescrever nem repetir",
    async correr(v) {
      const agora = Math.floor(Date.now() / 1000);
      const msg = "Não consegui reiniciar o add-on NGINX Home Assistant SSL proxy (400: App core_nginx_proxy is not running).";
      const casa = novaCasa({ dados: {
        "command.json": JSON.stringify({ id: 83, type: "addon_restart", slug: "core_nginx_proxy", title: "NGINX Home Assistant SSL proxy", started_at: agora - 30 }),
        "result.json": JSON.stringify({ id: 83, ok: false, message: msg, installed_version: null }),
      } });
      await esperar(() => resultados(83).length >= 1, 15000);
      await dormir(4000); // tempo para um segundo envio, se o houvesse
      const rs = resultados(83);
      v.ok(rs.length === 1, `um só resultado entregue (${rs.length})`);
      v.ok(rs[0] && isDeepStrictEqual(json(rs[0].corpo), { ok: false, message: msg, installed_version: null }), "é o resultado que estava gravado (ok:false), não um \"Concluído\"");
      v.ok(!casa.existe("command.json") && !casa.existe("result.json"), "command.json e result.json apagados");
      v.ok(pedidosSup("POST", "/addons/core_nginx_proxy/restart").length === 0, "não repetiu o comando");
      rs.forEach((p) => v.ev(`resultado #83 entregue: ${p.corpo}`));
      v.linhas(casa, /#83/);
    },
  },
  {
    n: 23,
    nome: "(extra) Sem espaço em /data para o result.json → o resultado vai direto ao relay, o registo diz porquê, e a fila não fica presa",
    async correr(v) {
      const agora = Math.floor(Date.now() / 1000);
      const casa = novaCasa({ semInodes: true, dados: {
        "command.json": JSON.stringify({ id: 85, type: "addon_restart", slug: "core_nginx_proxy", title: "NGINX Home Assistant SSL proxy", started_at: agora - 30 }),
      } });
      const res = await esperar(() => resultados(85)[0], 15000);
      v.ok(res && isDeepStrictEqual(json(res.corpo), { ok: true, message: "Concluído; o agente reiniciou entretanto.", installed_version: null }), "o resultado chegou ao relay");
      v.ok(casa.linhas().some((l) => l.includes("Não consegui gravar o resultado do comando #85")), "uma linha no registo a dizer que não gravou");
      v.ok(!casa.existe("command.json"), "command.json apagado");
      v.ev(`resultado: ${res && res.corpo}`);
      v.linhas(casa, /#85/);
    },
  },
  {
    n: 24,
    nome: "(extra) O trabalho de um comando morre sem resultado → o comando seguinte corre; o que morreu é dado por falhado",
    async correr(v) {
      sup.estado.aoInstalar = async () => { await dormir(120000); return null; };
      relay.estado.fila = [null, UPDATE_MOSQUITTO(101)];
      const casa = novaCasa();
      const install = await esperar(() => pedidosSup("POST", "/core/api/services/update/install")[0], 20000);
      v.ok(install, "o install do #101 começou");
      if (!install) return;
      await dormir(500);
      // Mata o trabalho em background, e o curl dele, como o OOM killer:
      // curl ← subshell do $(...) ← trabalho.
      const ps = casa.exec("ps", "-o", "pid,ppid,args").stdout.split("\n").map((l) => l.trim().split(/\s+/));
      const pai = (pid) => (ps.find((c) => c[0] === pid) || [])[1];
      const curl = ps.find((c) => c.includes("curl") && c.join(" ").includes("services/update/install"));
      const alvos = curl ? [curl[0], pai(curl[0]), pai(pai(curl[0]))].filter(Boolean) : [];
      const k = casa.exec("kill", "-9", ...alvos);
      v.ok(alvos.length === 3 && k.codigo === 0, `trabalho morto (${alvos.join(", ")})`);
      await dormir(1500);
      v.ok(casa.existe("command.json"), "o command.json ficou para trás");
      relay.estado.fila.push({ id: 102, type: "restart" });
      const r102 = await esperar(() => resultados(102)[0], 15000);
      const r101 = resultados(101)[0];
      v.ok(r101 && isDeepStrictEqual(json(r101.corpo), {
        ok: false, message: "O trabalho do agente parou a meio deste comando, sem resultado; vê no inventário se chegou a acontecer.", installed_version: null,
      }), "o #101 foi dado por falhado");
      v.ok(r102 && isDeepStrictEqual(json(r102.corpo), { ok: true, message: "O Home Assistant reiniciou.", installed_version: null }), "o #102 correu");
      v.ok(pedidosSup("POST", "/core/restart").length === 1, "o restart chegou ao Supervisor");
      v.ev(`#101: ${r101 && r101.corpo}`);
      v.ev(`#102: ${r102 && r102.corpo}`);
      v.linhas(casa, /#10[12]/);
    },
  },
  {
    n: 25,
    nome: "(extra) Registo sem resposta e depois 409 (o código gastou-se no pedido perdido) → a linha aponta o código para reinstalar, e pára",
    async correr(v) {
      const msg = "Este código de instalação já foi usado. Gera outro na consola Domnex.";
      relay.estado.registo = [{ status: 0 }, { status: 409, corpo: { error: "code_used", errorMessage: msg } }];
      const casa = novaCasa({ secret: "", code: CODIGO });
      v.segredosProibidos = [CODIGO];
      await dormir(8000);
      const regs = relay.pedidos.filter((p) => p.caminho === "/agent/register");
      v.ok(regs.length === 2, `dois pedidos de registo e mais nenhum (${regs.length})`);
      const recusa = casa.linhas().filter((l) => l.includes("Registo recusado"));
      v.ok(recusa.length === 1 && recusa[0].includes(msg) && recusa[0].includes("Código para reinstalar o agente"),
        "uma linha com o motivo e a indicação do código para reinstalar");
      v.linhas(casa, /regist/i);
    },
  },
  {
    n: 26,
    nome: "(extra) reboot num Pi que arranca com o relógio atrasado (boot_timestamp novo anterior ao pedido) → ok; o add-on reiniciado sem o Pi reiniciar → não",
    async correr(v) {
      relay.estado.fila = [null, { id: 62, type: "reboot" }];
      const casa = novaCasa();
      const reboot = await esperar(() => pedidosSup("POST", "/host/reboot")[0], 20000);
      v.ok(reboot, "pediu POST /host/reboot");
      if (!reboot) return;
      await dormir(1000);
      const emCurso = json(casa.ler("command.json") || "") || {};
      const antes = sup.estado.host.boot_timestamp;
      v.ok(emCurso.boot_before === antes, `o command.json guardou o arranque de antes do pedido (boot_before ${emCurso.boot_before}, o do Supervisor ${antes})`);
      // Só o add-on reinicia (o Pi não): o arranque continua o mesmo.
      casa.parar();
      casa.arrancar();
      await dormir(4000);
      v.ok(resultados(62).length === 0, "o add-on reiniciado com o mesmo arranque não conta como o Pi reiniciado");
      // Agora o Pi reinicia; sem RTC arranca com a hora da imagem (um mês
      // antes) até o NTP a acertar, e o FinishTimestamp fica dessa hora.
      casa.parar();
      sup.estado.host.boot_timestamp = ((emCurso.started_at || 0) - 30 * 86400) * 1e6;
      casa.arrancar();
      const res = await esperar(() => resultados(62)[0], 30000);
      v.ok(res && isDeepStrictEqual(json(res.corpo), { ok: true, message: "O Pi reiniciou.", installed_version: null }), "resultado ok: O Pi reiniciou.");
      v.ok(pedidosSup("POST", "/host/reboot").length === 1, "a retoma não voltou a pedir o reboot");
      v.ev(`command.json antes de parar: ${JSON.stringify(emCurso)}`);
      v.ev(`boot_timestamp novo: ${sup.estado.host.boot_timestamp} µs (anterior ao pedido, started_at × 10⁶ = ${emCurso.started_at * 1e6})`);
      v.ev(`resultado: ${res && res.corpo}`);
      v.linhas(casa, /#62/);
    },
  },
  {
    n: 27,
    nome: "(extra) Resultado recusado com 409 (comando cancelado ou já terminado) → apagado, uma linha, sem repetir",
    async correr(v) {
      relay.estado.statusResultado = 409;
      relay.estado.fila = [null, { id: 98, type: "inventory" }];
      const casa = novaCasa();
      await esperar(() => resultados(98).length >= 1, 15000);
      await dormir(4000);
      v.ok(resultados(98).length === 1, `entregue uma vez (${resultados(98).length})`);
      v.ok(!casa.existe("result.json"), "result.json apagado");
      v.ok(casa.linhas().some((l) => l.endsWith("O relay já não esperava o resultado do comando #98 (409).")), "uma linha no registo");
      v.linhas(casa, /#98/);
    },
  },
  {
    n: 28,
    nome: "(extra) O batimento com o ficheiro dos comandos impossível de abrir (/tmp cheio) → erro no registo, mas o agente não morre",
    async correr(v) {
      // A função batimento() do /run.sh da imagem, com o relay e o resto a
      // fingir e o $NOVOS num sítio que não abre. Um redirecionamento que
      // falha num `:` (comando especial do sh) matava a shell inteira.
      const t = [
        "eval \"$(sed -n '/^batimento() {/,/^}/p' /run.sh)\"",
        "log() { echo \"log: $*\"; }",
        "sup_dados() { return 1; }",
        "relay() { echo '{\"command\":null,\"commands\":[]}' > \"$CORPO\"; echo 200; }",
        "receber() { echo \"receber $1\"; }",
        "CORPO=$(mktemp); NOVOS=/nao/existe/novos; AGENT_VERSION=0.3.0",
        "batimento",
        "echo \"sobreviveu (rc=$?)\"",
      ].join("\n");
      const r = docker(["run", "--rm", "-i", "--entrypoint", "sh", IMAGEM, "-s"], `${t}\n`);
      v.ok(r.codigo === 0 && r.stdout.includes("sobreviveu (rc=0)"), `a shell sobreviveu (saída ${r.codigo}: ${r.stdout.trim() || "nada"})`);
      v.ev(`stderr (esperado, o ficheiro não abre): ${r.stderr.trim().replace(/\n/g, " | ")}`);
    },
  },
];

// ---------------------------------------------------------------------------
// Correr
// ---------------------------------------------------------------------------

// Só os contentores desta corrida (o nome leva o pid deste processo).
function limparContentores() {
  const r = docker(["ps", "-aq", "--filter", `name=${PREFIXO}`]);
  const ids = r.stdout.split(/\s+/).filter(Boolean);
  if (ids.length) docker(["rm", "-f", ...ids]);
}

async function main() {
  const args = process.argv.slice(2);
  const escolhidos = args.filter((a) => /^\d+$/.test(a)).map(Number);
  const lista = escolhidos.length ? cenarios.filter((c) => escolhidos.includes(c.n)) : cenarios;

  if (!args.includes("--sem-build")) {
    console.log(`A construir ${IMAGEM} a partir de ${path.relative(process.cwd(), PASTA_ADDON) || PASTA_ADDON} …`);
    const b = docker(["build", "--build-arg", `BUILD_FROM=${BASE}`, "-t", IMAGEM, PASTA_ADDON]);
    if (b.codigo !== 0) {
      console.error(b.saida);
      process.exit(2);
    }
  }
  process.on("SIGINT", () => {
    limparContentores();
    process.exit(130);
  });

  await new Promise((r) => relay.servidor.listen(PORTA_RELAY, "0.0.0.0", r));
  await new Promise((r) => sup.servidor.listen(PORTA_SUP, "0.0.0.0", r));
  PORTA_RELAY = relay.servidor.address().port;
  PORTA_SUP = sup.servidor.address().port;
  relay.publico = `http://${HOST}:${PORTA_RELAY}`;
  console.log(`Relay falso em :${PORTA_RELAY}, Supervisor falso em :${PORTA_SUP}, imagem ${IMAGEM}.`);

  const resumo = [];
  for (const c of lista) {
    relay.reiniciar();
    sup.reiniciar();
    casas.length = 0;
    const v = verificador();
    const t0 = Date.now();
    try {
      await c.correr(v);
    } catch (e) {
      v.falhas.push(`exceção: ${e.stack || e}`);
    }
    // Em todos os cenários: o registo nunca mostra o segredo nem o código, e
    // o stderr do agente fica vazio (nenhum jq a engasgar-se num corpo que
    // não é JSON).
    for (const casa of casas) {
      const r = casa.registo();
      for (const s of [SEGREDO, ...(v.segredosProibidos || [])]) {
        v.ok(!r.saida.includes(s), `o registo não mostra ${s === CODIGO ? "o código" : "o segredo"}`);
      }
      v.ok(!r.stderr.trim(), `stderr do agente vazio${r.stderr.trim() ? `: ${r.stderr.trim().slice(0, 300)}` : ""}`);
    }
    const passou = v.falhas.length === 0;
    console.log(`\n[${passou ? "PASSOU" : "FALHOU"}] ${c.n}. ${c.nome} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
    for (const e of v.evidencias) console.log(`    · ${e}`);
    for (const f of v.falhas) console.log(`    ✗ ${f}`);
    if (!passou) {
      for (const casa of casas) {
        console.log(`    --- registo de ${casa.nome} ---`);
        casa.registo().saida.split("\n").forEach((l) => console.log(`    | ${l}`));
      }
    }
    for (const casa of casas) casa.remover();
    resumo.push({ n: c.n, passou });
  }

  relay.servidor.close();
  sup.servidor.close();
  const falhados = resumo.filter((r) => !r.passou).map((r) => r.n);
  console.log(`\n${resumo.length - falhados.length}/${resumo.length} cenários passaram${falhados.length ? ` — falharam: ${falhados.join(", ")}` : "."}`);
  process.exit(falhados.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  limparContentores();
  process.exit(2);
});
