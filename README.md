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
