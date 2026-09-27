# Domnex Add-ons

O repositório de add-ons do Home Assistant que as casas da Domnex usam. É
daqui que o Supervisor de cada casa instala e atualiza o agente — um clique
na loja, em vez de copiar pastas à mão para `/addons`.

## Adicionar a uma casa

[![Adicionar o repositório ao Home Assistant](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2FLuispinto26%2Fdomnex-addons)

Ou à mão: **Definições → Add-ons → Loja de add-ons → ⋮ → Repositórios** e
colar `https://github.com/Luispinto26/domnex-addons`.

## Add-ons

| Add-on | O que faz |
|---|---|
| [Domnex Agente](domnex-agente/) | Entrega a cópia diária ao cofre da Domnex e mantém o batimento com a consola (versão do HA, reiniciar e atualizar à distância). As instruções de instalação e configuração estão em [DOCS.md](domnex-agente/DOCS.md). |

## Para quem edita

- Este repositório é a **fonte de verdade** do agente. O worker que o
  atende (`domnex-relay`, privado) fala com ele em `/agent/<uuid>/heartbeat`
  e `/backup/<uuid>/*`; mudanças de contrato entre os dois fazem-se nos dois
  repositórios, com o relay a aceitar sempre a versão anterior do agente
  (as casas atualizam quando o operador quiser, não todas ao mesmo tempo).
- Cada alteração que chega às casas é uma **versão nova** em
  `domnex-agente/config.yaml` mais uma entrada em
  `domnex-agente/CHANGELOG.md` — é o changelog que o Supervisor mostra ao
  operador antes de atualizar.
- O slug `omnex_backup` **não se muda** (ver o comentário no `config.yaml`).
- Fins de linha LF, sempre (ver `.gitattributes`). Um `\r` no shebang do
  `run.sh` mata o add-on no arranque.
