# Domnex Agente

O agente local da Domnex numa casa. Faz duas coisas, e só estas:

- **O batimento** — de minuto em minuto diz à consola "estou vivo, o Home
  Assistant é a versão X" e pergunta se o operador deixou algum recado. Um
  "reiniciar" ou "atualizar" levantado aqui executa-se pela API do
  Supervisor. É o único canal de comando que existe: o relay nunca entra na
  casa, é a casa que vem ao relay.
- **O carteiro das cópias** — de meia em meia hora espreita as cópias de
  segurança do Home Assistant e, quando há uma nova, entrega-a ao cofre da
  Domnex. Cada cópia é entregue uma vez. As cópias vão encriptadas pelo
  próprio Home Assistant, com a chave da casa — que nunca viaja com elas.

Nada sai da casa além disto: a versão do HA, o sinal de vida e o ficheiro
da cópia, autenticados pelo segredo desta casa.

## Instalar

1. Adicionar o repositório: **Definições → Add-ons → Loja de add-ons → ⋮ →
   Repositórios**, colar `https://github.com/Luispinto26/domnex-addons`.
2. Na loja, abrir **Domnex Agente** → **Instalar**. A imagem constrói-se no
   próprio Raspberry (um ou dois minutos).
3. Na consola Domnex, **Instalações → Segredo cópias** na casa certa. O
   segredo mostra-se uma vez; copiar.
4. No add-on, separador **Configuração** → colar o segredo em *Segredo de
   cópias* → **Guardar** → separador **Informação** → **Iniciar**. Ligar
   *Iniciar no arranque* e *Watchdog*.
5. No **Registo** deve aparecer o batimento; na consola a casa passa a
   "agente online" em menos de um minuto.

## Configuração

| Opção | O que é |
|---|---|
| `secret` | O segredo de cópias desta casa, gerado na consola. Sem ele o add-on fica quieto e diz no registo porquê. Gerar um novo na consola substitui o antigo — é assim que se roda um segredo perdido. |

O uuid da casa (o id da instância do Home Assistant) o add-on lê-o sozinho
em `/homeassistant/.storage/core.uuid`.

## Mudar uma casa da instalação local para esta

Até à 0.2.3 o agente instalava-se copiando a pasta para `/addons`, e o Home
Assistant conhecia-o como `local_omnex_backup`. Este add-on tem o mesmo slug
mas outro prefixo, por isso o HA vê-o como um add-on diferente — a mudança
faz-se uma vez, à mão:

1. Anotar o segredo que está na configuração do add-on local (ou gerar um
   novo na consola — os dois funcionam, o novo substitui o antigo).
2. Instalar **Domnex Agente** a partir deste repositório (passos 1–2 acima),
   colar o segredo, iniciar. Confirmar no registo que bate.
3. **Parar e desinstalar** o add-on local ("Local add-ons → Domnex Agente"
   com slug `local_omnex_backup`). Dois agentes a bater ao mesmo tempo não
   partem nada, mas não faz sentido.
4. Apagar a pasta `/addons/omnex-backup` (Samba, SSH ou o editor de
   ficheiros), para não voltar a aparecer na loja.

A marca da última cópia entregue vive no `/data` do add-on, que não passa de
um para o outro: a cópia de hoje é reenviada uma vez, escreve por cima da
mesma chave no cofre (`<uuid>/<dia>.tar`) e não duplica nada.

## O que aparece no registo

- `Sem segredo de cópias — gera um na consola e cola-o na configuração.` —
  a opção `secret` está vazia; o add-on não faz nada até a ter.
- `Não consegui ler o uuid da casa …` — o ficheiro `core.uuid` não está
  onde devia; o Home Assistant ainda não acabou de arrancar, ou o mapeamento
  `homeassistant_config` falhou.
- `Cópia entregue: <ficheiro>` — uma cópia nova chegou ao cofre.
- `A entrega falhou com <código>` / `O relay não deu URL de entrega` — o
  relay recusou (segredo errado dá 401) ou não respondeu; tenta na passagem
  seguinte, de meia em meia hora.
- `Reinício do Home Assistant pedido pela consola.` / `Atualização do Home
  Assistant pedida pela consola.` — um recado levantado e a executar.
