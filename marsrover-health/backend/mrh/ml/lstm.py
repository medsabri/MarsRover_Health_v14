"""Réseau LSTM (1 couche) + tête dense, implémenté en NumPy (aucune dépendance de deep learning).

Architecture « many-to-one » pour la régression de RUL :
    x_1..x_T (T × F)  →  LSTM(H)  →  h_T  →  Dense(D, ReLU)  →  Dense(1)  →  RUL normalisée

Cellule LSTM (Hochreiter & Schmidhuber 1997, porte d'oubli de Gers et al. 2000) :
    z_t = x_t W_x + h_{t-1} W_h + b = [z_i | z_f | z_g | z_o]
    i = σ(z_i)  f = σ(z_f)  g = tanh(z_g)  o = σ(z_o)
    c_t = f ⊙ c_{t-1} + i ⊙ g          h_t = o ⊙ tanh(c_t)
Apprentissage : rétropropagation à travers le temps (BPTT complète), perte MSE, optimiseur Adam
(Kingma & Ba 2015), écrêtage de la norme du gradient, arrêt précoce sur le jeu de validation.
Le gradient analytique est vérifié par différences finies dans tests/test_lstm.py.
"""
from __future__ import annotations

import time

import numpy as np


def _sig(x):
    return 1.0 / (1.0 + np.exp(-np.clip(x, -30, 30)))


class LSTMRegressor:
    def __init__(self, n_features: int, hidden: int = 32, dense: int = 16, lr: float = 3e-3, seed: int = 0, clip: float = 1.0):
        rng = np.random.default_rng(seed)
        F, H, D = n_features, hidden, dense
        lim_x, lim_h = np.sqrt(6 / (F + 4 * H)), np.sqrt(6 / (H + 4 * H))
        self.p = {
            "Wx": rng.uniform(-lim_x, lim_x, (F, 4 * H)),
            "Wh": rng.uniform(-lim_h, lim_h, (H, 4 * H)),
            "b": np.zeros(4 * H),
            "W1": rng.normal(0, np.sqrt(2 / H), (H, D)),
            "b1": np.zeros(D),
            "W2": rng.normal(0, np.sqrt(1 / D), (D, 1)),
            "b2": np.zeros(1),
        }
        self.p["b"][H:2 * H] = 1.0  # biais de la porte d'oubli initialisé à 1
        self.H, self.lr, self.clip = H, lr, clip
        self.m = {k: np.zeros_like(v) for k, v in self.p.items()}
        self.v = {k: np.zeros_like(v) for k, v in self.p.items()}
        self.step = 0
        self.history: list[dict] = []

    # ------------------------------------------------------------ propagation avant
    def forward(self, X):
        B, T, _ = X.shape
        H, p = self.H, self.p
        h = np.zeros((B, H)); c = np.zeros((B, H))
        cache = []
        for t in range(T):
            z = X[:, t, :] @ p["Wx"] + h @ p["Wh"] + p["b"]
            i, f, g, o = _sig(z[:, :H]), _sig(z[:, H:2 * H]), np.tanh(z[:, 2 * H:3 * H]), _sig(z[:, 3 * H:])
            c_prev, h_prev = c, h
            c = f * c_prev + i * g
            tc = np.tanh(c)
            h = o * tc
            cache.append((X[:, t, :], h_prev, c_prev, i, f, g, o, tc))
        a = h @ p["W1"] + p["b1"]
        r = np.maximum(a, 0)
        y = r @ p["W2"] + p["b2"]
        return y[:, 0], (cache, h, a, r)

    def predict(self, X, batch: int = 2048):
        return np.concatenate([self.forward(X[k:k + batch])[0] for k in range(0, len(X), batch)]) if len(X) else np.zeros(0)

    # ------------------------------------------------------------ rétropropagation (BPTT)
    def loss_and_grads(self, X, y):
        B = X.shape[0]
        H, p = self.H, self.p
        yhat, (cache, hT, a, r) = self.forward(X)
        err = yhat - y
        loss = float(np.mean(err ** 2))
        dy = (2.0 / B) * err[:, None]
        g = {k: np.zeros_like(v) for k, v in p.items()}
        g["W2"] = r.T @ dy; g["b2"] = dy.sum(0)
        da = (dy @ p["W2"].T) * (a > 0)
        g["W1"] = hT.T @ da; g["b1"] = da.sum(0)
        dh = da @ p["W1"].T
        dc = np.zeros_like(dh)
        for (x, h_prev, c_prev, i, f, gg, o, tc) in reversed(cache):
            do = dh * tc
            dc = dc + dh * o * (1 - tc ** 2)
            di, dg, df = dc * gg, dc * i, dc * c_prev
            dz = np.concatenate([di * i * (1 - i), df * f * (1 - f), dg * (1 - gg ** 2), do * o * (1 - o)], axis=1)
            g["Wx"] += x.T @ dz; g["Wh"] += h_prev.T @ dz; g["b"] += dz.sum(0)
            dh = dz @ p["Wh"].T
            dc = dc * f
        return loss, g

    def _adam(self, g, b1=0.9, b2=0.999, eps=1e-8):
        norm = np.sqrt(sum(float(np.sum(v ** 2)) for v in g.values()))
        scale = min(1.0, self.clip / (norm + 1e-12))
        self.step += 1
        for k in self.p:
            gk = g[k] * scale
            self.m[k] = b1 * self.m[k] + (1 - b1) * gk
            self.v[k] = b2 * self.v[k] + (1 - b2) * gk ** 2
            mh = self.m[k] / (1 - b1 ** self.step); vh = self.v[k] / (1 - b2 ** self.step)
            self.p[k] -= self.lr * mh / (np.sqrt(vh) + eps)

    def fit(self, X, y, Xv, yv, epochs: int = 60, batch: int = 256, patience: int = 8, seed: int = 0, verbose: bool = False):
        rng = np.random.default_rng(seed)
        best, best_p, wait = np.inf, None, 0
        t0 = time.time()
        for ep in range(epochs):
            idx = rng.permutation(len(X))
            tr = []
            for k in range(0, len(X), batch):
                bi = idx[k:k + batch]
                loss, g = self.loss_and_grads(X[bi], y[bi])
                if not np.isfinite(loss):
                    raise FloatingPointError("perte non finie pendant l'entraînement (divergence)")
                self._adam(g)
                tr.append(loss)
            vl = float(np.mean((self.predict(Xv) - yv) ** 2))
            self.history.append({"epoch": ep + 1, "train_mse": float(np.mean(tr)), "val_mse": vl, "elapsed_s": time.time() - t0})
            if verbose:
                print(self.history[-1])
            if vl < best - 1e-6:
                best, best_p, wait = vl, {k: v.copy() for k, v in self.p.items()}, 0
            else:
                wait += 1
                if wait >= patience:
                    break
        if best_p is not None:
            self.p = best_p
        self.best_val_mse = best
        return self

    def state(self):
        return {"p": self.p, "H": self.H, "history": self.history}

    @classmethod
    def from_state(cls, s):
        F = s["p"]["Wx"].shape[0]
        m = cls(F, hidden=s["H"], dense=s["p"]["W1"].shape[1])
        m.p = s["p"]; m.history = s.get("history", [])
        return m
