// Um Supervisor (e o Core atrás do proxy /core/api) falso, para testar o
// Domnex Agente sem um Home Assistant. Node puro, sem dependências.
//
// Responde nos formatos verificados nas fontes do Supervisor e do Core
// (envelope {"result":"ok","data":…}; 401 sem JSON sem token; 502 no
// /core/api/* enquanto o Core está "a reiniciar"; o template devolvido como
// text/plain; a entidade "unavailable"; os trabalhos em /jobs/info…) e
// grava tudo o que recebe, para os
// cenários verificarem o que o agente pediu e por que ordem.
//
// Uso nos testes: const sup = criarSupervisor(); sup.servidor.listen(porta).
// O estado (versões, add-ons, atualizações, ganchos) muda-se à mão em
// sup.estado; sup.pedidos é a lista do que chegou.

"use strict";

const http = require("http");

const TOKEN = "token-de-teste";

function estadoInicial() {
  const agoraUs = Date.now() * 1000;
  return {
    token: TOKEN,
    // Enquanto for true, tudo o que é /core/api/* responde 502 — é o que o
    // proxy do Supervisor faz quando o Core não está RUNNING.
    coreEmBaixo: false,
    core: { version: "2026.9.3", version_latest: "2026.9.4" },
    os: { version: "18.2", version_latest: "18.3", version_pending: null, board: "rpi5-64" },
    supervisor: { version: "2026.09.2", version_latest: "2026.09.2", channel: "stable", healthy: true, supported: true },
    host: {
      hostname: "homeassistant",
      disk_total: 28.6,
      disk_used: 11.7,
      disk_free: 16.9,
      kernel: "6.12.47-haos-raspi",
      operating_system: "Home Assistant OS 18.2",
      // Microssegundos, como o FinishTimestamp do systemd. Arranque há 1 h.
      boot_timestamp: agoraUs - 3600 * 1e6,
    },
    addons: [
      { slug: "core_mosquitto", name: "Mosquitto broker", version: "7.1.1", version_latest: "7.1.2", state: "started", repository: "core",
        // Armadilha: a lista real (/addons) não traz opções. Esta traz, para
        // provar que o agente escolhe os campos em vez de copiar tudo.
        options: { logins: [{ username: "casa", password: "segredo-do-mosquitto" }] } },
      { slug: "core_nginx_proxy", name: "NGINX Home Assistant SSL proxy", version: "4.5.1", version_latest: "4.5.1", state: "error", repository: "core" },
      { slug: "45df7312_zigbee2mqtt", name: "Zigbee2MQTT", version: "2.14.1-1", version_latest: "2.14.1-1", state: "started", repository: "45df7312" },
      { slug: "6f094f0c_omnex_backup", name: "Domnex Agente", version: "0.3.0", version_latest: "0.3.0", state: "started", repository: "6f094f0c" },
    ],
    // As opções que o /addons/<slug>/info mostra a um add-on manager. O
    // agente nunca pode chegar aqui.
    opcoesAddons: { core_mosquitto: { logins: [{ username: "casa", password: "segredo-do-mosquitto" }] } },
    entradas: [
      { entry_id: "e1", domain: "sun", title: "Sun", source: "import", state: "loaded", disabled_by: null, created_at: 1, modified_at: 1 },
      { entry_id: "e2", domain: "hassio", title: "Supervisor", source: "system", state: "loaded", disabled_by: null, created_at: 1, modified_at: 1 },
      { entry_id: "e3", domain: "shelly", title: "Shelly da sala", source: "zeroconf", state: "loaded", disabled_by: null, created_at: 1, modified_at: 1 },
      // O título de uma entrada pode ter o email do cliente: não pode sair da casa.
      { entry_id: "e4", domain: "google_drive", title: "cliente.privado@exemplo.pt", source: "user", state: "setup_retry", disabled_by: null, created_at: 1, modified_at: 1 },
      { entry_id: "e5", domain: "mqtt", title: "Mosquitto broker", source: "hassio", state: "loaded", disabled_by: "user", created_at: 1, modified_at: 1 },
    ],
    // As entidades update.*. As do hassio seguem as versões acima (como o
    // Core faz), as outras têm as versões aqui.
    updates: {
      "update.home_assistant_core_update": { title: "Home Assistant Core", hassio_id: "core", platform: "hassio", supported_features: 15, release_url: "https://www.home-assistant.io/latest-release-notes/" },
      "update.home_assistant_operating_system_update": { title: "Home Assistant Operating System", hassio_id: "OS", platform: "hassio", supported_features: 27, release_url: "https://github.com/home-assistant/operating-system/releases/tag/18.3" },
      "update.home_assistant_supervisor_update": { title: "Home Assistant Supervisor", hassio_id: "supervisor", platform: "hassio", supported_features: 5, release_url: null },
      "update.mosquitto_broker_update": { title: "Mosquitto broker", hassio_id: "core_mosquitto", platform: "hassio", supported_features: 29, release_url: null },
      "update.nginx_home_assistant_ssl_proxy_update": { title: "NGINX Home Assistant SSL proxy", hassio_id: "core_nginx_proxy", platform: "hassio", supported_features: 29, release_url: null },
      "update.shelly_sala_firmware": { title: "Shelly Sala", hassio_id: null, platform: "shelly", supported_features: 5, release_url: null, installed_version: "1.7.5", latest_version: "1.7.6" },
    },
    // Entidades que estão "unavailable".
    indisponiveis: new Set(),
    // Os trabalhos do Supervisor (/jobs/info). A atualização do Core é um
    // trabalho "home_assistant_core_update" que só acaba depois de o Core
    // novo arrancar e passar a verificação (ou de voltar à versão anterior).
    trabalhos: [],
    // Ganchos dos cenários. aoInstalar(corpo) devolve {status, corpo, tipo}
    // (ou uma Promise disso); por omissão 200 [] sem mudar nada.
    aoInstalar: null,
    aoReiniciarPi: null,
    atrasoAddonMs: 0,
  };
}

function criarSupervisor() {
  const sup = { estado: estadoInicial(), pedidos: [] };

  sup.reiniciar = () => {
    sup.estado = estadoInicial();
    sup.pedidos.length = 0;
  };

  // Um trabalho novo em /jobs/info, na forma do SupervisorJob.as_dict();
  // devolve-o para o cenário lhe mudar o `done`.
  sup.novoTrabalho = (name, reference = null) => {
    const t = { name, reference, uuid: Math.random().toString(16).slice(2).padEnd(32, "0"), progress: 0, stage: null,
      done: false, errors: [], created: new Date().toISOString(), extra: null, child_jobs: [] };
    sup.estado.trabalhos.push(t);
    return t;
  };

  const ok = (data) => ({ status: 200, tipo: "application/json", corpo: JSON.stringify({ result: "ok", data }) });
  const erro = (status, message) => ({ status, tipo: "application/json", corpo: JSON.stringify({ result: "error", message }) });
  const jsonCore = (status, v) => ({ status, tipo: "application/json", corpo: JSON.stringify(v) });

  function addon(slug) {
    return sup.estado.addons.find((a) => a.slug === slug);
  }

  // Uma entidade update.* como o Core a mostra em /api/states.
  function entidade(id) {
    const e = sup.estado.updates[id];
    if (!e) return null;
    const s = sup.estado;
    let instalada = e.installed_version;
    let ultima = e.latest_version;
    if (e.hassio_id === "core") [instalada, ultima] = [s.core.version, s.core.version_latest];
    else if (e.hassio_id === "OS") [instalada, ultima] = [s.os.version_pending || s.os.version, s.os.version_latest];
    else if (e.hassio_id === "supervisor") [instalada, ultima] = [s.supervisor.version, s.supervisor.version_latest];
    else if (e.hassio_id) {
      const a = addon(e.hassio_id);
      if (a) [instalada, ultima] = [a.version, a.version_latest];
    }
    if (s.indisponiveis.has(id)) {
      return { entity_id: id, state: "unavailable", attributes: { friendly_name: e.title, supported_features: e.supported_features } };
    }
    return {
      entity_id: id,
      state: instalada === ultima ? "off" : "on",
      attributes: {
        auto_update: false, display_precision: 0, installed_version: instalada, in_progress: false, latest_version: ultima,
        release_summary: null, release_url: e.release_url, skipped_version: null, title: e.title, update_percentage: null,
        friendly_name: e.title, supported_features: e.supported_features,
      },
      last_changed: new Date().toISOString(),
    };
  }

  // O que o molde de §6.1 do contrato devolve, calculado a partir do estado.
  function saidaDoMolde() {
    return Object.keys(sup.estado.updates).map((id) => {
      const e = sup.estado.updates[id];
      const st = entidade(id);
      const a = st.attributes;
      return {
        entity_id: id, title: a.title || e.title, installed_version: a.installed_version ?? null, latest_version: a.latest_version ?? null,
        supported_features: a.supported_features ?? null, platform: e.platform, hassio_id: e.hassio_id,
        in_progress: a.in_progress ?? null, release_url: a.release_url ?? null, state: st.state, skipped_version: a.skipped_version ?? null,
      };
    });
  }

  async function responder(metodo, caminho, corpo) {
    const s = sup.estado;

    // O proxy do Core.
    if (caminho.startsWith("/core/api/")) {
      if (s.coreEmBaixo) return { status: 502, tipo: "text/plain; charset=utf-8", corpo: "502: Bad Gateway" };
      const resto = caminho.slice("/core/api/".length);
      if (metodo === "GET" && resto === "config/config_entries/entry") return jsonCore(200, s.entradas);
      // A configuração do Core que está a correr: a versão é a dele (o
      // proxy só chega aqui com o Core a correr).
      if (metodo === "GET" && resto === "config") {
        return jsonCore(200, { version: s.core.version, state: "RUNNING", components: ["http", "frontend", "websocket_api", "update"],
          location_name: "Casa", time_zone: "Europe/Lisbon" });
      }
      if (metodo === "POST" && resto === "template") {
        let t;
        try { t = JSON.parse(corpo).template; } catch { return jsonCore(400, { message: "Invalid JSON specified." }); }
        if (typeof t !== "string" || !t.includes("states.update") || !t.includes("tojson")) {
          return jsonCore(400, { message: "Error rendering template: molde inesperado" });
        }
        return { status: 200, tipo: "text/plain; charset=utf-8", corpo: JSON.stringify(saidaDoMolde()) };
      }
      const m = /^states\/(update\.[a-z0-9_]+)$/.exec(resto);
      if (metodo === "GET" && m) {
        const e = entidade(m[1]);
        return e ? jsonCore(200, e) : jsonCore(404, { message: "Entity not found." });
      }
      if (metodo === "POST" && resto === "services/update/install") {
        const r = s.aoInstalar ? await s.aoInstalar(JSON.parse(corpo || "{}")) : null;
        return r || jsonCore(200, []);
      }
      return jsonCore(404, { message: "Not found" });
    }

    if (metodo === "GET") {
      switch (caminho) {
        case "/info":
          return ok({ supervisor: s.supervisor.version, homeassistant: s.core.version, hassos: s.os.version, docker: "28.3.3",
            hostname: s.host.hostname, operating_system: s.host.operating_system, features: ["reboot", "shutdown"],
            machine: "raspberrypi5-64", machine_id: "abc123", arch: "aarch64", state: "running",
            supported_arch: ["aarch64"], supported: true, channel: "stable", logging: "info", timezone: "Europe/Lisbon" });
        case "/core/info":
          return ok({ ...s.core, update_available: s.core.version !== s.core.version_latest, machine: "raspberrypi5-64",
            ip_address: "172.30.32.1", arch: "aarch64", image: "ghcr.io/home-assistant/raspberrypi5-64-homeassistant",
            boot: true, port: 8123, ssl: false, watchdog: true });
        case "/os/info":
          return ok({ ...s.os, update_available: s.os.version !== s.os.version_latest && s.os.version_pending !== s.os.version_latest,
            boot: "A", data_disk: "mmcblk0", boot_slots: {} });
        case "/supervisor/info":
          return ok({ ...s.supervisor, update_available: false, arch: "aarch64", ip_address: "172.30.32.2", timezone: "Europe/Lisbon",
            logging: "info", debug: false, debug_block: false, diagnostics: true, auto_update: true, country: "PT",
            addons: s.addons.map(({ name, slug, version, version_latest, state, repository }) => ({ name, slug, version, version_latest, update_available: version !== version_latest, state, repository, icon: false })),
            addons_repositories: [{ name: "Domnex Add-ons", slug: "6f094f0c" }] });
        case "/host/info":
          return ok({ ...s.host, agent_version: "1.8.1", apparmor_version: "3.1.2", chassis: "embedded", virtualization: "",
            cpe: "cpe:2.3:o:home-assistant:haos:18.2:*:production:*:*:*:rpi5-64:*", deployment: "production",
            disk_life_time: null, features: ["reboot"], llmnr_hostname: "homeassistant", timezone: "Europe/Lisbon",
            dt_utc: new Date().toISOString(), dt_synchronized: true, use_ntp: true, startup_time: 12.5 });
        case "/network/info":
          return ok({
            interfaces: [
              { interface: "end0", type: "ethernet", enabled: true, connected: true, primary: true, mac: "2C:CF:67:00:00:01",
                ipv4: { method: "auto", address: ["192.168.1.84/24"], nameservers: ["192.168.1.1"], gateway: "192.168.1.1", route_metric: 100, ready: true },
                ipv6: { method: "auto", address: ["fe80::1/64"], nameservers: [], gateway: null, ready: true }, wifi: null, vlan: null },
              // Uma interface sem IPv4 configurado: ipv4 vem null.
              { interface: "wlan0", type: "wireless", enabled: false, connected: false, primary: false, mac: "2C:CF:67:00:00:02",
                ipv4: null, ipv6: null, wifi: null, vlan: null },
            ],
            docker: { interface: "hassio", address: "172.30.32.0/23", gateway: "172.30.32.1", dns: "172.30.32.3" },
            host_internet: true, supervisor_internet: true,
          });
        case "/hardware/info":
          return ok({
            devices: [
              { name: "ttyUSB0", sysfs: "/sys/devices/platform/usb/ttyUSB0", dev_path: "/dev/ttyUSB0", subsystem: "tty",
                by_id: "/dev/serial/by-id/usb-ITead_Sonoff_Zigbee_3.0_USB_Dongle_Plus_4c1f3b0f7a2bed11-if00-port0",
                attributes: { DEVNAME: "/dev/ttyUSB0", ID_BUS: "usb", ID_VENDOR_ID: "10c4", ID_MODEL_ID: "ea60", ID_VENDOR: "ITead",
                  ID_MODEL: "Sonoff_Zigbee_3.0_USB_Dongle_Plus", ID_USB_VENDOR_ID: "10c4", ID_USB_MODEL_ID: "ea60",
                  ID_USB_VENDOR: "ITead", ID_USB_MODEL: "Sonoff_Zigbee_3.0_USB_Dongle_Plus" }, children: [] },
              // Só com os ID_USB_* (o ID_BUS já vinha de outra regra).
              { name: "ttyACM0", sysfs: "/sys/devices/platform/usb/ttyACM0", dev_path: "/dev/ttyACM0", subsystem: "tty",
                by_id: "/dev/serial/by-id/usb-SONOFF_SONOFF_Dongle_Plus_MG24_9a8b7c6d-if00-port0",
                attributes: { DEVNAME: "/dev/ttyACM0", ID_USB_VENDOR_ID: "10c4", ID_USB_MODEL_ID: "ea60", ID_USB_VENDOR: "SONOFF",
                  ID_USB_MODEL: "SONOFF_Dongle_Plus_MG24" }, children: [] },
              // Uma porta série sem by_id (a UART do Pi) e um disco: ficam de fora.
              { name: "ttyAMA10", sysfs: "/sys/devices/platform/ttyAMA10", dev_path: "/dev/ttyAMA10", subsystem: "tty", by_id: null, attributes: {}, children: [] },
              { name: "sda", sysfs: "/sys/devices/platform/usb/sda", dev_path: "/dev/sda", subsystem: "block",
                by_id: "/dev/disk/by-id/usb-Samsung_SSD-0:0", attributes: { ID_VENDOR: "Samsung" }, children: [] },
            ],
            drives: [],
          });
        case "/addons":
          return ok({ addons: s.addons.map((a) => ({ ...a, description: "…", stage: "stable", update_available: a.version !== a.version_latest,
            available: true, detached: false, homeassistant: null, build: false, url: null, icon: true, logo: true, system_managed: false, advanced: false })) });
        case "/jobs/info":
          return ok({ ignore_conditions: [], jobs: s.trabalhos });
      }
      const info = /^\/addons\/([a-z0-9_]+)\/info$/.exec(caminho);
      if (info) {
        const a = addon(info[1]);
        return a ? ok({ ...a, options: s.opcoesAddons[a.slug] || {} }) : erro(404, `App ${info[1]} does not exist`);
      }
    }

    if (metodo === "POST") {
      const acao = /^\/addons\/([a-z0-9_]+)\/(start|stop|restart)$/.exec(caminho);
      if (acao) {
        const a = addon(acao[1]);
        if (!a) return erro(400, `App ${acao[1]} is not installed`);
        if (s.atrasoAddonMs) await new Promise((r) => setTimeout(r, s.atrasoAddonMs));
        a.state = acao[2] === "stop" ? "stopped" : "started";
        return ok({});
      }
      if (caminho === "/core/restart" || caminho === "/core/update") return ok({});
      if (caminho === "/host/reboot") {
        if (s.aoReiniciarPi) s.aoReiniciarPi();
        return ok({});
      }
    }
    return erro(404, "Not found");
  }

  sup.servidor = http.createServer((req, res) => {
    let partes = [];
    req.on("data", (c) => partes.push(c));
    req.on("end", async () => {
      const corpo = Buffer.concat(partes).toString("utf8");
      const url = new URL(req.url, "http://supervisor");
      const registo = { t: Date.now(), metodo: req.method, caminho: url.pathname, corpo, auth: req.headers.authorization || null };
      sup.pedidos.push(registo);
      // Sem o token do add-on: 401 sem JSON, como o middleware do Supervisor
      // (e o proxy do Core, para um add-on sem homeassistant_api).
      if (req.headers.authorization !== `Bearer ${sup.estado.token}`) {
        registo.status = 401;
        res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
        res.end("401: Unauthorized");
        return;
      }
      let r;
      try {
        r = await responder(req.method, url.pathname, corpo);
      } catch (e) {
        r = { status: 500, tipo: "text/plain", corpo: "500 Internal Server Error\n\nServer got itself in trouble" };
      }
      registo.status = r.status;
      if (r.status === 0) {
        // Ligação cortada sem resposta (curl vê "000").
        req.socket.destroy();
        return;
      }
      res.writeHead(r.status, { "content-type": r.tipo || "application/json" });
      res.end(r.corpo);
    });
  });

  return sup;
}

module.exports = { criarSupervisor, TOKEN };

if (require.main === module) {
  const porta = Number(process.env.PORTA || 18432);
  criarSupervisor().servidor.listen(porta, "0.0.0.0", () => console.log(`Supervisor falso em :${porta} (token ${TOKEN})`));
}
