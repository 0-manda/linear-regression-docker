/*
 * cripto.js — Criptografia feita à mão (sem bibliotecas), igual à da API (app/cripto.py).
 * Cifra de fluxo: XOR com uma sequência pseudoaleatória gerada a partir da senha.
 * Formato: [2 bytes "PI"] + [2 bytes checksum (big-endian)] + [dados cifrados]
 *
 * ============================ EXEMPLO DE USO ============================
 * No HTML, carregue este arquivo ANTES do script.js:
 *   <input type="file" id="arquivo">
 *   <input type="password" id="senha">      <!-- o usuário digita a senha -->
 *   <script src="cripto.js"></script>
 *   <script src="script.js"></script>
 *
 * IMPORTANTE: NUNCA escreva a senha no código JS. Ela sempre vem do campo
 * <input type="password">, digitada pelo usuário.
 *
 * Enviar para /train (ou /predict, que funciona do mesmo jeito):
 *   const file  = document.getElementById("arquivo").files[0];
 *   const senha = document.getElementById("senha").value;
 *   const blob  = await criptografarArquivo(file, senha);
 *   const form  = new FormData();
 *   form.append("arquivo", blob, "dados.cripto");
 *   const resp  = await fetch("http://localhost:8000/train", { method: "POST", body: form });
 *   const json  = await resp.json();            // as métricas vêm em JSON normal
 *
 * Baixar as previsões de /download:
 *   const resp = await fetch("http://localhost:8000/download");
 *   const csv  = await descriptografarResposta(resp, senha);
 *   baixarBlob(csv, "previsoes.csv");
 *
 * Os erros (senha errada etc.) são lançados como Error: use try/catch e
 * mostre erro.message para o usuário.
 * =========================================================================
 */

// ---------------------------- Funções base ----------------------------

// Senha -> número (hash caseiro: h = h * 31 + byte, em 32 bits)
function gerarSemente(senha) {
  if (!senha) throw new Error("A senha não pode ser vazia.");
  const bytes = new TextEncoder().encode(senha); // senha em UTF-8
  let h = 0;
  for (const b of bytes) {
    h = (Math.imul(h, 31) + b) >>> 0; // ">>> 0" mantém o número em 32 bits sem sinal
  }
  return h;
}

// XOR de cada byte com a sequência pseudoaleatória.
// O XOR é simétrico: (x ^ k) ^ k == x.
// Por isso ESTA MESMA função criptografa e descriptografa.
function aplicarXor(bytes, senha) {
  let estado = gerarSemente(senha);
  const resultado = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    // Gerador LCG (constantes do rand() do C). Math.imul multiplica em 32 bits
    // sem perder precisão (a multiplicação normal erra acima de 2^53).
    estado = (Math.imul(1103515245, estado) + 12345) >>> 0;
    const byteChave = (estado >>> 16) & 0xff;
    resultado[i] = bytes[i] ^ byteChave;
  }
  return resultado;
}

// Soma de todos os bytes, limitada a 2 bytes (0 a 65535)
function calcularChecksum(bytes) {
  let soma = 0;
  for (const b of bytes) soma = (soma + b) % 65536;
  return soma;
}

// Devolve "PI" + checksum (2 bytes) + dados cifrados
function criptografar(bytes, senha) {
  const cifrado = aplicarXor(bytes, senha);
  const checksum = calcularChecksum(bytes);
  const saida = new Uint8Array(4 + cifrado.length);
  saida[0] = 80; // "P"
  saida[1] = 73; // "I"
  saida[2] = checksum >> 8;   // big-endian: primeiro o byte alto...
  saida[3] = checksum & 0xff; // ...depois o byte baixo
  saida.set(cifrado, 4);
  return saida;
}

// Confere a assinatura, decifra e confere o checksum
function descriptografar(bytes, senha) {
  if (bytes.length < 4 || bytes[0] !== 80 || bytes[1] !== 73) {
    throw new Error("O arquivo não está criptografado.");
  }
  const checksum = bytes[2] * 256 + bytes[3]; // junta os 2 bytes (big-endian)
  const original = aplicarXor(bytes.subarray(4), senha); // mesma função da criptografia
  if (calcularChecksum(original) !== checksum) {
    throw new Error("Senha errada ou arquivo corrompido.");
  }
  return original;
}

// ------------------- Funções de alto nível (para o front) -------------------

// Recebe o File de um <input type="file"> e devolve o Blob cifrado para o FormData
async function criptografarArquivo(file, senha) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return new Blob([criptografar(bytes, senha)], { type: "application/octet-stream" });
}

// Recebe o Response do fetch no /download e devolve o CSV decifrado
async function descriptografarResposta(resposta, senha) {
  if (!resposta.ok) {
    // A API manda o erro em JSON: {"detail": "..."}
    let mensagem = "Erro " + resposta.status + " na API.";
    try { mensagem = (await resposta.json()).detail || mensagem; } catch (e) {}
    throw new Error(mensagem);
  }
  const bytes = new Uint8Array(await resposta.arrayBuffer());
  return new Blob([descriptografar(bytes, senha)], { type: "text/csv" });
}

// Dispara o download de um Blob no navegador
function baixarBlob(blob, nomeArquivo) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = nomeArquivo;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000); // libera a memória depois do download
}
