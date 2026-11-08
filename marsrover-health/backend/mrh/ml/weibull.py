"""Loi de Weibull à 2 paramètres — estimation par maximum de vraisemblance avec censure à droite.

    R(t) = exp(-(t/η)^β)        F(t) = 1 - R(t)        λ(t) = (β/η)(t/η)^(β-1)
    f(t) = λ(t) R(t)            MTTF = η Γ(1 + 1/β)

Log-vraisemblance (δ_i = 1 si défaillance, 0 si censure) :
    ℓ(β, η) = Σ δ_i [ln β − β ln η + (β−1) ln t_i] − Σ (t_i/η)^β

Optimisation sur (ln β, ln η) (contraintes de positivité implicites) ; intervalles de confiance
par la matrice d'information observée (hessienne numérique) et méthode delta sur l'échelle log.
"""
from __future__ import annotations

import math

import numpy as np
from scipy import optimize, special, stats


def loglik(theta, t, d):
    lb, le = theta
    b, e = math.exp(lb), math.exp(le)
    z = t / e
    return float(np.sum(d * (math.log(b) - b * le + (b - 1) * np.log(t))) - np.sum(z ** b))


def fit(t, d, alpha: float = 0.10) -> dict:
    t = np.asarray(t, float)
    d = np.asarray(d, float)
    if t.size < 2 or d.sum() < 2:
        return {"ok": False, "reason": f"{int(d.sum())} défaillance(s) observée(s) : au moins 2 sont nécessaires."}
    if np.any(t <= 0):
        return {"ok": False, "reason": "durées non strictement positives"}
    # départ : régression de rang médian (Bernard) sur les défaillances
    x0 = np.array([0.0, math.log(np.mean(t))])
    res = optimize.minimize(lambda th: -loglik(th, t, d), x0, method="Nelder-Mead", options={"xatol": 1e-10, "fatol": 1e-10, "maxiter": 20000})
    res = optimize.minimize(lambda th: -loglik(th, t, d), res.x, method="BFGS")
    lb, le = res.x
    H = _hess(lambda th: -loglik(th, t, d), res.x)
    try:
        cov = np.linalg.inv(H)
        se = np.sqrt(np.clip(np.diag(cov), 0, None))
    except np.linalg.LinAlgError:
        cov, se = None, np.array([np.nan, np.nan])
    z = stats.norm.ppf(1 - alpha / 2)
    b, e = math.exp(lb), math.exp(le)
    return {
        "ok": True, "beta": b, "eta": e, "loglik": -float(res.fun), "n": int(t.size), "failures": int(d.sum()), "censored": int((1 - d).sum()),
        "beta_ci": [math.exp(lb - z * se[0]), math.exp(lb + z * se[0])], "eta_ci": [math.exp(le - z * se[1]), math.exp(le + z * se[1])],
        "cov_log": None if cov is None else cov.tolist(), "alpha": alpha, "mttf": e * special.gamma(1 + 1 / b),
        "aic": 2 * 2 + 2 * float(res.fun),
    }


def _hess(f, x, h=1e-4):
    x = np.asarray(x, float)
    n = x.size
    H = np.zeros((n, n))
    for i in range(n):
        for k in range(n):
            ei, ek = np.eye(n)[i] * h, np.eye(n)[k] * h
            H[i, k] = (f(x + ei + ek) - f(x + ei - ek) - f(x - ei + ek) + f(x - ei - ek)) / (4 * h * h)
    return H


def R(t, beta, eta):
    return np.exp(-(np.asarray(t, float) / eta) ** beta)


def F(t, beta, eta):
    return 1 - R(t, beta, eta)


def hazard(t, beta, eta):
    t = np.asarray(t, float)
    return (beta / eta) * (t / eta) ** (beta - 1)


def R_ci(t, fit_res: dict):
    """IC ponctuel de R(t) par méthode delta sur u = ln H(t) = β (ln t − ln η)."""
    t = np.asarray(t, float)
    b, e = fit_res["beta"], fit_res["eta"]
    cov = np.asarray(fit_res["cov_log"])
    z = stats.norm.ppf(1 - fit_res["alpha"] / 2)
    u = b * (np.log(t) - math.log(e))
    # du/d lnβ = β (ln t − ln η) ; du/d lnη = −β
    g1, g2 = u, -b * np.ones_like(t)
    var = g1 ** 2 * cov[0, 0] + 2 * g1 * g2 * cov[0, 1] + g2 ** 2 * cov[1, 1]
    sd = np.sqrt(np.clip(var, 0, None))
    return np.exp(-np.exp(u + z * sd)), np.exp(-np.exp(u - z * sd))


def kaplan_meier(t, d):
    """Estimateur de Kaplan–Meier (référence non paramétrique)."""
    t, d = np.asarray(t, float), np.asarray(d, int)
    times = np.unique(t[d == 1])
    S, out = 1.0, []
    for u in times:
        n = np.sum(t >= u)
        k = np.sum((t == u) & (d == 1))
        S *= 1 - k / n
        out.append((float(u), float(S)))
    return out
