# A base por omissão é a imagem oficial do HA para o Pi. O Supervisor pode
# sobrepô-la via BUILD_FROM quando souber fazê-lo.
ARG BUILD_FROM=ghcr.io/home-assistant/aarch64-base:latest
FROM $BUILD_FROM

# O curl e o jq são o trabalho do agente; o coreutils dá um `date -r`
# previsível para a marca das cópias. Instalam-se em vez de se assumir que
# a base os traz — ela muda ao longo do tempo, é uma etiqueta flutuante.
RUN apk add --no-cache curl jq coreutils

COPY run.sh /
# O `sed` não é paranoia: o add-on esteve em ciclo de reinício durante três
# reconstruções por causa de um \r no fim do shebang. O ficheiro tinha sido
# copiado para a casa a partir do Windows, onde o Git converte para CRLF ao
# fazer checkout, e o s6 procurava um interpretador chamado "sh\r":
#
#   exec: fatal: unable to exec sh
#   : No such file or directory
#
# A mensagem engana — o `sh` existe. O `.gitattributes` na raiz do
# repositório já força LF no checkout; isto apanha o caso de o ficheiro
# chegar por outro caminho (editor do HA, Samba, cópia à mão).
RUN sed -i 's/\r$//' /run.sh && chmod a+x /run.sh
CMD [ "/run.sh" ]
