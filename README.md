# Trabalho PI – Regressão com KNN em Docker

API que treina e executa um modelo de **regressão com KNN** (k vizinhos mais próximos) sobre uma série temporal:
a coluna `time` é prevista a partir dos 5 momentos anteriores (`time-5` … `time-1`).

Para prever uma linha nova, o modelo procura as **k linhas do treino mais parecidas** com ela
(comparando os 5 valores anteriores) e devolve a **média do `time`** dessas linhas.

Para comparar, a API também treina uma **regressão linear** com a mesma normalização e a mesma validação cruzada.
O KNN é o modelo principal; a regressão linear aparece ao lado nas métricas e no CSV de previsões.

Tecnologias: Python 3.12, FastAPI, scikit-learn, Docker.

## Estrutura

```
linear-regression-docker/
├── app/
│   ├── main.py          # API (rotas de treino, predição, download, status e reset)
│   ├── cripto.py        # criptografia feita à mão (também usada pelo terminal)
│   └── graficos.py      # gráficos de treino e de teste (PNG)
├── frontend/            # página web servida pela API em /site
├── analise/             # notebook de análise e CSVs de exemplo
├── requirements.txt     # bibliotecas Python
├── Dockerfile           # receita do container
├── docker-compose.yml   # sobe tudo com um comando (opcional)
└── README.md
```

## Os arquivos CSV

| Arquivo | Tem a coluna `time`? | Para que serve |
|---|---|---|
| `PI_train.csv` | Sim | **Treinar** o modelo (`/train`). O modelo aprende com o `time`. |
| `PI_test-1.csv` | Sim | **Testar** (`/predict`). O modelo NÃO usa o `time` para prever; ele serve só de gabarito para medir o desempenho real. |
| `PI_application-1.csv` | Não | **Aplicar** (`/predict`). Não há gabarito: o modelo só prevê e devolve o CSV. |

A API decide sozinha: se o CSV enviado ao `/predict` tem a coluna `time` preenchida, ela avalia; se não tem, só prevê.
Os arquivos de teste e aplicação "de verdade" serão entregues pelo professor na arguição; os da pasta `analise/` são exemplos com o mesmo formato.

## Como usar (passo a passo)

Precisa do **Docker Desktop aberto** e de **Python** instalado no PC (só para criptografar/descriptografar os arquivos; o `cripto.py` não usa nenhuma biblioteca).

**1. Construir a imagem** (na pasta do projeto; repita sempre que mudar o código)

```powershell
docker build -t linear-regression-docker .
```

**2. Subir o container com a senha**

```powershell
docker run --rm -p 8000:8000 -v modelos-pi:/code/modelos -e SENHA_PI=minhaSenha linear-regression-docker
```

Deixe esse terminal aberto. Para parar: `Ctrl+C`.

**3. Criptografar os CSVs** (em outro terminal, na pasta do projeto, com a mesma senha)

```powershell
python app/cripto.py criptografar analise/PI_train.csv treino.cripto minhaSenha
python app/cripto.py criptografar analise/PI_test-1.csv teste.cripto minhaSenha
python app/cripto.py criptografar analise/PI_application-1.csv aplicacao.cripto minhaSenha
```

A API só aceita arquivos criptografados: um `.csv` comum é recusado com "O arquivo não está criptografado".

**4. Abrir o Swagger:** http://localhost:8000/docs

Em cada rota: clique nela → **Try it out** → escolha o arquivo → **Execute**.

**5. Treinar:** `POST /train` com `treino.cripto`
→ a resposta mostra o **desempenho esperado** (RMSE ≈ 84,2 · MAE ≈ 60,4 · R² ≈ 0,43) e o k escolhido.
Em `regressao_linear` aparece o desempenho esperado da regressão linear (RMSE ≈ 85,7 · MAE ≈ 63,6 · R² ≈ 0,41).
Gráficos: http://localhost:8000/graficos/treino

**6. Testar:** `POST /predict` com `teste.cripto`
→ a resposta mostra o **desempenho real** ao lado do **esperado** (real: RMSE ≈ 103,0 · MAE ≈ 72,3 · R² ≈ 0,43).
Em `regressao_linear` aparece o mesmo para a regressão linear (real: RMSE ≈ 113,0 · MAE ≈ 82,1 · R² ≈ 0,31).
Gráficos: http://localhost:8000/graficos/teste

**7. Baixar as previsões:** `GET /download` → **Execute** → **Download file** (vem `previsoes.cripto`). Depois:

```powershell
python app/cripto.py descriptografar previsoes.cripto previsoes.csv minhaSenha
```

O `previsoes.csv` tem as colunas originais + `time_previsto_knn` (KNN) + `time_previsto_regressao_linear` (regressão linear).

**8. Aplicar:** `POST /predict` com `aplicacao.cripto` → só previsões, sem métricas. Baixe como no passo 7.
(Atenção: cada `/predict` substitui o arquivo de previsões anterior, então baixe antes de enviar outro.)

**9. Resetar:** `POST /reset` → `GET /status` volta a `modelo_treinado: false`. Agora dá para treinar em outra base (passo 5).

## Rotas

| Rota | Método | O que faz |
|---|---|---|
| `/status` | GET | Diz se há modelo treinado e mostra o desempenho esperado |
| `/train` | POST | Recebe o CSV de treino (criptografado), aplica min-max, escolhe o melhor k, treina e calcula o desempenho esperado (validação cruzada 10-fold) |
| `/predict` | POST | Recebe um CSV criptografado. **Com** coluna `time`: previsões + desempenho real vs. esperado. **Sem** `time`: só as previsões |
| `/download` | GET | Devolve o CSV de previsões criptografado |
| `/graficos/treino` | GET | Gráficos do desempenho esperado |
| `/graficos/teste` | GET | Gráficos do teste (real × previsto, esperado × real) |
| `/reset` | POST | Apaga modelo, métricas, previsões e gráficos para treinar em outra base |

## Decisões técnicas

- **Por que KNN?** É simples de explicar ("média dos vizinhos mais parecidos") e funciona para regressão.
- **Regressão linear para comparar**: treinada junto com o KNN, do mesmo jeito (min-max + validação cruzada 10-fold).
  Nessa base o KNN erra um pouco menos, por isso ele é o modelo principal.
- **Min-max dentro de um `Pipeline`**: o KNN mede distâncias, então todas as colunas precisam estar na mesma escala (0 a 1).
  O scaler aprende mínimo/máximo só com os dados de treino (inclusive dentro de cada parte da validação cruzada),
  evitando *data leakage*. No teste, os dados são normalizados com os valores do treino.
- **Escolha automática do k (`GridSearchCV`)**: testa k = 3, 5, 7 … 41 e fica com o de menor erro.
  Como o professor pode trazer uma base nova, o k se ajusta sozinho a cada treino.
- **Desempenho esperado** = validação cruzada 10-fold: cada linha é prevista por um modelo que não a viu,
  e o k é escolhido de novo dentro de cada parte (para a estimativa não ficar otimista).
  O modelo final é treinado com 100% dos dados.
- **Sem gráficos antigos**: um novo `/train` apaga o gráfico de teste e as previsões do modelo anterior,
  e um `/predict` sem rótulo apaga o gráfico de teste (não há teste novo para mostrar).
- **Alerta de faixa**: `/predict` informa quantos valores do teste ficam fora da faixa vista no treino
  (o KNN não consegue prever valores maiores que os que viu no treino).

## Criptografia

Feita à mão, sem bibliotecas, e igual em Python ([app/cripto.py](app/cripto.py)) e JavaScript ([frontend/cripto.js](frontend/cripto.js)).
É uma cifra de fluxo: cada byte é combinado por XOR com uma sequência pseudoaleatória (gerador LCG) criada a partir da senha.
O arquivo cifrado tem o formato `"PI"` (2 bytes) + checksum (2 bytes, big-endian) + dados cifrados.
O checksum é a soma dos bytes originais % 65536; se não bater depois de decifrar, a senha está errada ou o arquivo foi alterado.

**Fluxo:** o cliente criptografa o CSV → a API descriptografa → processa (treino/predição) → criptografa a resposta (`/download`) → o cliente descriptografa.
As respostas JSON (métricas, insights) continuam em texto normal.
A senha vem da variável de ambiente `SENHA_PI` e nunca fica no código.

É uma criptografia didática: num sistema real usaríamos um algoritmo padrão (ex.: AES) e HTTPS.

## CORS

Por segurança, o navegador bloqueia um `fetch` feito por uma página de **outra origem** (outra porta, outro domínio ou um arquivo aberto direto, `file://`).
Para o front conseguir chamar a API, o `main.py` liga o `CORSMiddleware` do FastAPI com `allow_origins=["*"]`.
Isso é aceitável aqui porque não há login e os arquivos já trafegam criptografados;
num sistema real, o `"*"` seria trocado pelo endereço exato do front.

## Andamento

- [x] Etapa 1 – Container com FastAPI
- [x] Etapa 2 – Treino, desempenho esperado e reset
- [x] Etapa 3 – Predição com e sem rótulos
- [x] Etapa 4 – Criptografia ponta-a-ponta

## Fluxo de trabalho no Git (para o grupo)

1. Antes de começar: **Sincronizar / Pull** (pegar as mudanças dos outros)
2. Fazer as alterações e testar com Docker
3. **Commit** com mensagem clara (ex.: "Adiciona rota de predição")
4. **Sync / Push** para enviar
