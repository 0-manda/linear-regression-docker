"""Criptografia feita à mão (sem bibliotecas): cifra de fluxo com XOR.

Formato do arquivo criptografado:
    [2 bytes "PI"] + [2 bytes checksum (big-endian)] + [dados cifrados]

O mesmo algoritmo existe em frontend/cripto.js e dá o mesmo resultado, byte a byte.
"""
import sys

ASSINATURA = b"PI"   # marca que o arquivo foi criptografado por nós
MOD = 2 ** 32        # mantém os números em 32 bits (igual ao JavaScript)


def gerar_semente(senha):
    """Transforma a senha num número (hash caseiro: h = h * 31 + byte)."""
    if not senha:
        raise ValueError("A senha não pode ser vazia.")
    h = 0
    for b in senha.encode("utf-8"):
        h = (h * 31 + b) % MOD
    return h


def aplicar_xor(dados, senha):
    """Faz o XOR de cada byte com um byte da sequência pseudoaleatória.

    O XOR é simétrico: (x ^ k) ^ k == x.
    Por isso ESTA MESMA função criptografa e descriptografa.
    """
    estado = gerar_semente(senha)
    resultado = bytearray()
    for b in dados:
        # Gerador LCG (mesmas constantes do rand() da linguagem C)
        estado = (1103515245 * estado + 12345) % MOD
        byte_chave = (estado >> 16) & 0xFF
        resultado.append(b ^ byte_chave)
    return bytes(resultado)


def calcular_checksum(dados):
    """Soma de todos os bytes, limitada a 2 bytes (0 a 65535)."""
    return sum(dados) % 65536


def criptografar(dados: bytes, senha) -> bytes:
    """Devolve "PI" + checksum (2 bytes) + dados cifrados."""
    checksum = calcular_checksum(dados)
    # Big-endian: primeiro o byte alto, depois o byte baixo
    cabecalho = ASSINATURA + bytes([checksum >> 8, checksum & 0xFF])
    return cabecalho + aplicar_xor(dados, senha)


def descriptografar(dados: bytes, senha) -> bytes:
    """Confere a assinatura, decifra e confere o checksum."""
    if len(dados) < 4 or dados[:2] != ASSINATURA:
        raise ValueError("O arquivo não está criptografado.")
    checksum = dados[2] * 256 + dados[3]  # junta os 2 bytes (big-endian)
    original = aplicar_xor(dados[4:], senha)  # mesma função da criptografia
    if calcular_checksum(original) != checksum:
        raise ValueError("Senha errada ou arquivo corrompido.")
    return original


# Uso pelo terminal:
#   python app/cripto.py criptografar entrada.csv saida.cripto SENHA
#   python app/cripto.py descriptografar entrada.cripto saida.csv SENHA
if __name__ == "__main__":
    if len(sys.argv) != 5 or sys.argv[1] not in ("criptografar", "descriptografar"):
        print("Uso: python app/cripto.py criptografar|descriptografar ENTRADA SAIDA SENHA")
        sys.exit(1)

    acao, entrada, saida, senha = sys.argv[1:]
    with open(entrada, "rb") as f:
        conteudo = f.read()

    try:
        if acao == "criptografar":
            resultado = criptografar(conteudo, senha)
        else:
            resultado = descriptografar(conteudo, senha)
    except ValueError as erro:
        print("Erro:", erro)
        sys.exit(1)

    with open(saida, "wb") as f:
        f.write(resultado)
    print(f"Pronto: {saida} ({len(resultado)} bytes)")
