# Ferramentas

Scripts que correm no PC do técnico, não nas casas. Esta pasta não tem
`config.yaml`: o Supervisor ignora-a, e nenhuma casa instala ou atualiza
nada daqui.

## verificar-copia.py

Confirma que a chave de encriptação guardada no cofre da Domnex abre uma
cópia do Home Assistant descarregada da consola. Lê o `backup.json` (sem
chave), mostra a cópia, a versão do HA e cada arquivo interno com a versão
SecureTar, e pede a chave. Depois decifra e descomprime cada arquivo
interno até ao fim, em memória, aos bocados de 1 MiB. **Não escreve nada no
disco** e a chave nunca aparece no ecrã.

Usa o `securetar` 2026.4.1, a mesma biblioteca (e versão) com que o
Supervisor escreve e lê as cópias. Lê SecureTar v1, v2 e v3.

### Uma vez por PC (PowerShell)

```
winget install Python.Python.3.11
py -3.11 -m pip install securetar==2026.4.1
```

- Depois do `winget`, fecha e volta a abrir o PowerShell, para o `py`
  encontrar o Python novo.
- Se o PC já tiver Python 3.12 ou 3.13, também serve: troca `-3.11` por essa
  versão nesta linha e na de baixo (`py -0` lista as que há).
- Para descarregar o script: no GitHub, abre
  `ferramentas/verificar-copia.py` e carrega em **Download raw file**. Guarda-o
  na pasta **Transferências**, ao lado da cópia.

### Cada verificação

1. Na ficha da casa, descarrega a última cópia para a pasta
   **Transferências** (não para o Ambiente de trabalho nem para os
   Documentos, que o OneDrive pode estar a copiar para a nuvem).
2. No separador **Chaves**, revela a Chave das cópias. A revelação fica
   registada.
3. No PowerShell, na pasta da cópia:

   ```
   cd $HOME\Downloads
   py -3.11 verificar-copia.py <ficheiro da cópia>.tar
   ```

4. Quando pedir a chave, cola-a (Ctrl+V ou botão direito do rato) e carrega
   em Enter. Não aparece nada no ecrã enquanto a colas: é assim mesmo.

### O que deve aparecer

Uma cópia boa acaba assim (exemplo de uma cópia de teste):

```
Cópia: Automatic backup 2026.9.3 de 2026-09-30T04:45:12.345678+00:00
HA 2026.9.3; cifrada: sim
  homeassistant.tar.gz  3.2 MB  SecureTar v3 (Argon2id + XChaCha20-Poly1305)
  core_mosquitto.tar.gz  0.0 MB  SecureTar v3 (Argon2id + XChaCha20-Poly1305)
  share.tar.gz  0.0 MB  SecureTar v3 (Argon2id + XChaCha20-Poly1305)
  supervisor.tar.gz  0.0 MB  SecureTar v3 (Argon2id + XChaCha20-Poly1305)
Chave de encriptação (não aparece no ecrã):
ok     homeassistant.tar.gz  (74.2 MB decifrados)
ok     core_mosquitto.tar.gz  (0.0 MB decifrados)
ok     share.tar.gz  (0.0 MB decifrados)
ok     supervisor.tar.gz  (0.0 MB decifrados)

A chave abre a cópia inteira.
```

O que conta é a última linha. O código de saída vê-se com
`echo $LASTEXITCODE`.

| Última linha | Saída | Quer dizer | O que fazer |
|---|---|---|---|
| `A chave abre a cópia inteira.` | 0 | A chave do cofre abre todos os arquivos da cópia, até ao fim. | Marcar o passo no guia. |
| `CHAVE ERRADA: esta chave não é a da cópia.` | 1 | Cópia SecureTar v3: a chave não é a desta cópia. | Ver a chave no HA da casa e corrigir o cofre. Depois, correr outra vez. |
| `Algum arquivo não abriu: chave errada (cópias SecureTar v1/v2) ou cópia estragada ou cortada.` | 1 | Numa cópia v1/v2 a chave errada só se nota assim. Numa v3, a cópia está estragada. | Descarregar outra vez. Se repetir, fazer uma cópia nova no HA e verificar essa. |
| `Algum arquivo não abriu: cópia estragada ou cortada.` (depois de `A cópia não abre: …`) | 1 | O tar de fora não abre, ou falta o `backup.json` (quase sempre, uma descarga cortada). | Descarregar outra vez. |
| `A CÓPIA NÃO ESTÁ CIFRADA: …` | 2 | O local Este sistema (This system) do HA guarda as cópias sem encriptação. | Ligar a encriptação desse local e fazer outra cópia. |
| `uso: …`, `Não encontro o ficheiro …`, `Não chegou chave nenhuma …`, `Falta o securetar …` | 64 | Uso errado. | Seguir o que a mensagem diz. |

### Higiene (sempre)

- A chave nunca vai na linha de comandos, num ficheiro, em notas, em email
  ou em chat. O script pede-a e não a escreve em lado nenhum.
- **Nunca restaures a cópia num HA com rede.** A cópia traz a identidade da
  casa e o agente dela: ligado à internet, esse HA passava por gémeo da casa
  do cliente.
- No fim, apaga o `.tar` com **Shift+Delete**, que não passa pela
  Reciclagem. É a casa inteira do cliente.
- Limpa a área de transferência: **Win+V → Limpar tudo**. Com o histórico
  da área de transferência ligado, a chave fica lá guardada.

### Porque decifra a cópia inteira

- **SecureTar v3** (as cópias do HA 2026.3 em diante): Argon2id e
  XChaCha20-Poly1305 em blocos de 1 MiB. Uma chave errada falha logo no
  cabeçalho, e um bloco alterado ou uma cópia cortada também falham.
- **SecureTar v1/v2** (HA mais antigo): AES-128-CBC sem autenticação. Uma
  chave errada ou um ficheiro estragado só se notam porque o gzip não sai
  certo. Por isso o script descomprime até ao fim e confere o CRC do gzip,
  em vez de ler só o início (que é o que a validação do próprio HA faz).

### Para quem edita

- As últimas linhas (`A chave abre a cópia inteira.`, `CHAVE ERRADA`,
  `A CÓPIA NÃO ESTÁ CIFRADA`, `Algum arquivo não abriu`) são citadas pelo
  guia de instalação da consola Domnex. Mudar uma é mudar o guia também.
- A única dependência é o `securetar`, com a versão fixa na do Supervisor.
  Quando o Supervisor mudar de versão, muda-se no script e neste README,
  juntos.
- Fins de linha LF.
