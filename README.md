# Trabalho PI – Regressão Linear em Nuvem

API que treina e executa um modelo de **regressão linear** sobre uma série temporal:
a coluna `time` é prevista a partir dos 5 momentos anteriores (`time-5` … `time-1`).

Tecnologias: Python 3.12, FastAPI, scikit-learn, Docker (e futuramente Azure).

## Estrutura

```
linear-regression-docker/
├── app/
│   └── main.py          # API (rotas de treino, predição, status e reset)
├── requirements.txt     # bibliotecas Python
├── Dockerfile           # receita do container
├── .gitignore           # o que NÃO vai para o GitHub
└── README.md
```

## Como rodar (precisa do Docker Desktop aberto)

Na pasta do projeto:

```powershell
# 1. Construir a imagem (repita sempre que mudar o código)
docker build -t linear-regression-docker .

# 2. Subir o container (o volume guarda o modelo entre execuções)
docker run --rm -p 8000:8000 -v modelos-pi:/code/modelos linear-regression-docker
```

Depois abra **http://localhost:8000/docs** para testar pelo Swagger.
Para parar: `Ctrl+C` no terminal.

## Rotas

| Rota | Método | O que faz |
|---|---|---|
| `/status` | GET | Diz se há modelo treinado e mostra o desempenho esperado |
| `/train` | POST | Recebe o CSV de treino, aplica min-max, treina e calcula o desempenho esperado (validação cruzada 10-fold) |
| `/predict` | POST | Recebe um CSV de teste. **Com** coluna `time`: devolve previsões + desempenho real vs. esperado. **Sem** `time`: devolve só as previsões |
| `/reset` | POST | Apaga o modelo para treinar em outra base |

## Como testar

1. `POST /train` com `PI_train.csv` → espera-se RMSE ≈ 84,3 · MAE ≈ 63,7 · R² ≈ 0,41
2. `POST /predict` com `PI_test-1.csv` → traz a comparação esperado × real
3. `POST /predict` com `PI_application-1.csv` → só previsões
4. `POST /reset` → `/status` volta a `modelo_treinado: false`

## Decisões técnicas

- **Min-max dentro de um `Pipeline`**: o scaler aprende mínimo/máximo só com os dados de treino
  (inclusive dentro de cada fold da validação cruzada), evitando *data leakage*.
  No teste, os dados são normalizados com os valores do treino.
- **Desempenho esperado** = média da validação cruzada 10-fold; o modelo final é treinado com 100% dos dados.
- **Alerta de faixa**: `/predict` informa quantos valores do teste ficam fora da faixa vista no treino.

## Criptografia

Feita à mão, sem bibliotecas, e igual em Python ([app/cripto.py](app/cripto.py)) e JavaScript ([frontend/cripto.js](frontend/cripto.js)).
É uma cifra de fluxo: cada byte é combinado por XOR com uma sequência pseudoaleatória (gerador LCG) criada a partir da senha.
O arquivo cifrado tem o formato `"PI"` (2 bytes) + checksum (2 bytes, big-endian) + dados cifrados.
O checksum é a soma dos bytes originais % 65536; se não bater depois de decifrar, a senha está errada ou o arquivo foi alterado.

**Fluxo:** o cliente criptografa o CSV → a API descriptografa → processa (treino/predição) → criptografa a resposta (`/download`) → o cliente descriptografa.
As respostas JSON (métricas, insights) continuam em texto normal.

**Rodar com a senha** (a senha nunca fica no código):

```powershell
docker run --rm -p 8000:8000 -v modelos-pi:/code/modelos -e SENHA_PI=minhaSenha linear-regression-docker
```

**Pelo terminal** (útil para gerar arquivos e testar no Swagger):

```powershell
python app/cripto.py criptografar analise/PI_train.csv treino.cripto minhaSenha
python app/cripto.py descriptografar previsoes.cripto previsoes.csv minhaSenha
```

**Guia para o front** (o exemplo completo está no topo do `cripto.js`):

1. No HTML, carregue `<script src="cripto.js"></script>` antes do `script.js`.
2. A senha vem de um `<input type="password">` (nunca escrita no JS).
3. `/train` e `/predict`: `criptografarArquivo(file, senha)` → coloque o Blob no `FormData` com o campo `arquivo` → `fetch` POST.
4. `/download`: `fetch` → `descriptografarResposta(resposta, senha)` → `baixarBlob(blob, "previsoes.csv")`.
5. Erros (senha errada etc.) vêm como `Error`: use `try/catch` e mostre `erro.message`.

Para demonstrar sem a API, abra [frontend/teste_cripto.html](frontend/teste_cripto.html) direto no navegador.

## CORS

Por segurança, o navegador bloqueia um `fetch` feito por uma página de **outra origem** (outra porta, outro domínio ou um arquivo aberto direto, `file://`).
Para o front conseguir chamar a API, o `main.py` liga o `CORSMiddleware` do FastAPI:

- `allow_origins=["*"]`: aceita qualquer origem, inclusive `file://`, que o navegador envia como `null`;
- `allow_methods` e `allow_headers`: aceita qualquer método e cabeçalho;
- `allow_credentials=False`: a API não usa cookies nem login;
- `expose_headers=["Content-Disposition"]`: o front consegue ler o nome do arquivo no `/download`.

O `"*"` é aceitável aqui porque não há login e os arquivos já trafegam criptografados.
Num sistema real, o `"*"` seria trocado pelo endereço exato do front (ex.: `["https://meu-front.com"]`).

## Andamento

- [x] Etapa 1 – Container com FastAPI
- [x] Etapa 2 – Treino, desempenho esperado e reset
- [ ] Etapa 3 – Predição com e sem rótulos
- [ ] Etapa 4 – Compactação + criptografia ponta-a-ponta e cliente
- [ ] Etapa 5 – Deploy no Azure

## Fluxo de trabalho no Git (para o grupo)

1. Antes de começar: **Sincronizar / Pull** (pegar as mudanças dos outros)
2. Fazer as alterações e testar com Docker
3. **Commit** com mensagem clara (ex.: "Adiciona rota de predição")
4. **Sync / Push** para enviar
