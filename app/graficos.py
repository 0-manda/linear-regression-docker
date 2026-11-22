"""Funções que desenham os gráficos e salvam como imagem PNG."""
import matplotlib
matplotlib.use("Agg")  # gera as imagens sem precisar de tela (o Docker não tem tela)
import matplotlib.pyplot as plt
import numpy as np


def grafico_treino(y, y_prev, faixas, erros_por_k, melhor_k, caminho):
    """4 gráficos sobre o desempenho ESPERADO (vindo da validação cruzada)."""
    erro = y_prev - y
    fig, ax = plt.subplots(2, 2, figsize=(12, 9))
    fig.suptitle("Desempenho esperado do modelo (validação cruzada)", fontsize=14)

    # 1) Real x Previsto: quanto mais perto da linha vermelha, melhor
    limite = [0, max(y.max(), y_prev.max())]
    ax[0, 0].scatter(y, y_prev, alpha=0.5)
    ax[0, 0].plot(limite, limite, "r--", label="previsão perfeita")
    ax[0, 0].set_title("Valor real x valor previsto")
    ax[0, 0].set_xlabel("Real")
    ax[0, 0].set_ylabel("Previsto")
    ax[0, 0].legend()

    # 2) Histograma dos erros: o ideal é ficar concentrado perto do zero
    ax[0, 1].hist(erro, bins=30, edgecolor="black")
    ax[0, 1].axvline(0, color="red", linestyle="--")
    ax[0, 1].set_title("Distribuição dos erros (previsto - real)")
    ax[0, 1].set_xlabel("Erro")
    ax[0, 1].set_ylabel("Quantidade")

    # 3) Erro para cada k testado: mostra por que o k escolhido é o melhor
    ks = list(erros_por_k.keys())
    ax[1, 0].plot(ks, list(erros_por_k.values()), marker="o")
    ax[1, 0].axvline(melhor_k, color="red", linestyle="--", label=f"melhor k = {melhor_k}")
    ax[1, 0].set_title("Erro médio (MAE) para cada número de vizinhos")
    ax[1, 0].set_xlabel("k (vizinhos)")
    ax[1, 0].set_ylabel("MAE")
    ax[1, 0].legend()

    # 4) Erro por faixa de valor: o modelo erra mais nos valores altos?
    mae_faixa = np.abs(erro).groupby(faixas, observed=True).mean()
    ax[1, 1].bar(mae_faixa.index.astype(str), mae_faixa.values, color="orange")
    ax[1, 1].set_title("Erro médio por faixa do valor real")
    ax[1, 1].set_ylabel("MAE")

    fig.tight_layout()
    fig.savefig(caminho)
    plt.close(fig)


def grafico_teste(y, y_prev, esperado, real, caminho):
    """2 gráficos sobre o teste: real x previsto e esperado x real."""
    fig, ax = plt.subplots(1, 2, figsize=(12, 5))
    fig.suptitle("Desempenho real no teste", fontsize=14)

    limite = [0, max(y.max(), y_prev.max())]
    ax[0].scatter(y, y_prev, alpha=0.5, color="green")
    ax[0].plot(limite, limite, "r--", label="previsão perfeita")
    ax[0].set_title("Valor real x valor previsto (teste)")
    ax[0].set_xlabel("Real")
    ax[0].set_ylabel("Previsto")
    ax[0].legend()

    # Barras lado a lado: esperado (treino) x real (teste)
    nomes = ["MAE", "RMSE"]
    pos = np.arange(len(nomes))
    ax[1].bar(pos - 0.2, [esperado["mae"], esperado["rmse"]], 0.4, label="Esperado (treino)")
    ax[1].bar(pos + 0.2, [real["mae"], real["rmse"]], 0.4, label="Real (teste)")
    ax[1].set_xticks(pos, nomes)
    ax[1].set_title("Erro esperado x erro real (menor é melhor)")
    ax[1].legend()

    fig.tight_layout()
    fig.savefig(caminho)
    plt.close(fig)
