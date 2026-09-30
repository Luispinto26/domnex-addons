#!/usr/bin/env python3
"""Verifica que uma chave de encriptação abre uma cópia do Home Assistant.

Uso:  py -3.11 verificar-copia.py <copia.tar>
A chave pede-se no teclado (não aparece no ecrã nem fica no histórico da
shell) e nunca se escreve em lado nenhum. Nada decifrado vai para o disco:
cada arquivo interno é decifrado e descomprimido em memória, aos bocados,
até ao fim, e deitado fora.

Precisa de Python >= 3.11 e de `pip install securetar==2026.4.1` (a versão
que o Supervisor usa; lê SecureTar v1, v2 e v3).

Saída: 0 a chave abre a cópia inteira; 1 não abre (chave errada, ou cópia
estragada ou cortada); 2 cópia não cifrada; 64 uso errado.
"""

import getpass
import json
import sys
import tarfile
import zlib
from pathlib import Path

try:
    from securetar import InvalidPasswordError, SecureTarArchive
except ImportError:
    print("Falta o securetar: py -3.11 -m pip install securetar==2026.4.1")
    sys.exit(64)

INTERNOS = (".tar", ".tar.gz", ".tgz")
BLOCO = 1 << 20  # 1 MiB (read() do securetar precisa de tamanho explícito)


class NaoAbre(Exception):
    """Decifrou, mas o que saiu não é um tar (ou um tar.gz inteiro)."""


def versao_securetar(cabeca: bytes) -> str:
    if cabeca[:9] != b"SecureTar":
        return "v1 (AES-128-CBC, sem cabeçalho)"
    versoes = {b"\x02": "v2 (AES-128-CBC)", b"\x03": "v3 (Argon2id + XChaCha20-Poly1305)"}
    return versoes.get(cabeca[9:10], "desconhecida")


def ler_metadados(caminho: Path) -> tuple[dict, list[tuple[str, int, str]]]:
    """backup.json e a lista de arquivos internos, sem chave nenhuma."""
    with tarfile.open(caminho, "r:") as fora:  # o tar de fora não é cifrado
        nomes = fora.getnames()
        meta_nome = next((n for n in nomes if n.endswith(("backup.json", "snapshot.json"))), None)
        if meta_nome is None:
            # O Supervisor escreve o backup.json em último: sem ele, a cópia
            # foi cortada a meio (descarga interrompida) ou não é do HA.
            raise ValueError("não há backup.json (cópia cortada, ou não é uma cópia do HA)")
        meta = json.load(fora.extractfile(meta_nome))
        internos = []
        for m in fora.getmembers():
            if m.isfile() and m.name.endswith(INTERNOS):
                internos.append((m.name, m.size, versao_securetar(fora.extractfile(m).read(16))))
    return meta, internos


def verificar_interno(arq: SecureTarArchive, membro: tarfile.TarInfo) -> int:
    """Decifra e descomprime até ao fim; devolve os bytes do tar interno."""
    gz = membro.name.endswith((".tar.gz", ".tgz"))
    d = zlib.decompressobj(31) if gz else None  # 31 = gzip, confere o CRC no fim
    cabeca = b""
    total = 0
    with arq.extract_tar(membro) as fluxo:
        while bloco := fluxo.read(BLOCO):
            # Também descomprime 1 MiB de cada vez: um bloco cheio de zeros
            # comprimidos dava gigabytes de uma vez só.
            while bloco:
                dados = d.decompress(bloco, BLOCO) if d else bloco
                bloco = d.unconsumed_tail if d else b""
                if len(cabeca) < 512:
                    cabeca += dados[: 512 - len(cabeca)]
                total += len(dados)
    if d:
        total += len(d.flush())
        if not d.eof:
            raise NaoAbre("o gzip acaba a meio (cópia cortada)")
    if cabeca[257:262] != b"ustar":
        raise NaoAbre("decifrado, mas não é um tar")
    return total


def main() -> int:
    if len(sys.argv) != 2:
        print("uso: py -3.11 verificar-copia.py <copia.tar>")
        return 64
    caminho = Path(sys.argv[1])
    if not caminho.is_file():
        print(f"Não encontro o ficheiro {caminho}")
        return 64
    try:
        meta, internos = ler_metadados(caminho)
    except (tarfile.TarError, OSError, ValueError) as e:
        print(f"A cópia não abre: {e}")
        print("\nAlgum arquivo não abriu: cópia estragada ou cortada.")
        return 1
    protegida = bool(meta.get("protected"))
    print(f"Cópia: {meta.get('name')} de {meta.get('date')}")
    print(f"HA {(meta.get('homeassistant') or {}).get('version')}; cifrada: {'sim' if protegida else 'não'}")
    for nome, tam, versao in internos:
        print(f"  {nome}  {tam / 1e6:.1f} MB" + (f"  SecureTar {versao}" if protegida else ""))
    if not protegida:
        print("\nA CÓPIA NÃO ESTÁ CIFRADA: o local Este sistema (This system) tem a encriptação desligada no HA.")
        return 2
    if not internos:
        print("\nA cópia não traz arquivos internos: não há nada para a chave abrir.")
        return 1

    chave = getpass.getpass("Chave de encriptação (não aparece no ecrã): ").strip()
    if not chave:
        print("Não chegou chave nenhuma. Cola-a com Ctrl+V ou com o botão direito do rato, e Enter.")
        return 64
    falhas = 0
    with SecureTarArchive(caminho, "r", password=chave) as arq:
        for membro in arq.tar.getmembers():
            if not (membro.isfile() and membro.name.endswith(INTERNOS)):
                continue
            try:
                total = verificar_interno(arq, membro)
                print(f"ok     {membro.name}  ({total / 1e6:.1f} MB decifrados)")
            except InvalidPasswordError:
                # Só o v3 sabe dizer que a chave é errada (logo no cabeçalho).
                print(f"FALHA  {membro.name}: chave errada")
                print("\nCHAVE ERRADA: esta chave não é a da cópia.")
                return 1
            except NaoAbre as e:
                print(f"FALHA  {membro.name}: {e}")
                falhas += 1
            except Exception as e:
                # Tudo o que não abre conta como falha. Só o tipo do erro: a
                # mensagem de uma biblioteca podia trazer um bocado da chave.
                # No v1/v2 a chave errada também cai aqui (sai lixo, não gzip).
                print(f"FALHA  {membro.name}: {type(e).__module__}.{type(e).__name__}")
                falhas += 1
    if falhas:
        print("\nAlgum arquivo não abriu: chave errada (cópias SecureTar v1/v2) ou cópia estragada ou cortada.")
        return 1
    print("\nA chave abre a cópia inteira.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
