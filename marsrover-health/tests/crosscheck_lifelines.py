"""Validation croisée des estimateurs JS contre lifelines (référence Python)."""
import json, pandas as pd, numpy as np
from lifelines import KaplanMeierFitter, WeibullFitter, NelsonAalenFitter, LogNormalFitter
o = json.load(open('tests/ml_check_out.json'))
rep = {}
for f, tc in [('bearings_datareal_exp.csv','T_obs_Mcycles'),('reliability_500_sim.csv','T_obs_h'),('fire_detectors_demo.csv','T_obs_mois')]:
    d = pd.read_csv('data/datasets/'+f); T=d[tc].values; E=d['event_1_panne_0_censure'].values
    km = KaplanMeierFitter().fit(T,E); sf = km.survival_function_.iloc[:,0]; ci = km.confidence_interval_
    js = o[f]; err=[]
    for t,s,lo,hi in zip(js['km_t'][1:],js['km_S'][1:],js['km_lo'][1:],js['km_hi'][1:]):
        err.append(max(abs(sf.loc[t]-s), abs(ci.loc[t].iloc[0]-lo), abs(ci.loc[t].iloc[1]-hi)))
    wf = WeibullFitter().fit(T,E); na = NelsonAalenFitter().fit(T,E); ln = LogNormalFitter().fit(T,E)
    rep[f] = {'KM+IC max abs err': float(max(err)), 'median JS/lifelines': [js['median'], float(km.median_survival_time_)],
      'Weibull beta JS/lifelines': [js['weib'][0], float(wf.rho_)], 'Weibull eta JS/lifelines': [js['weib'][1], float(wf.lambda_)],
      'NA H(tmax) JS/lifelines': [js['na_H_last'], float(na.cumulative_hazard_.iloc[-1,0])],
      'Lognormal mu,sigma JS/lifelines': [js['logn'], [float(ln.mu_), float(ln.sigma_)]]}
print(json.dumps(rep, indent=1))
json.dump(rep, open('tests/crosscheck_lifelines_out.json','w'), indent=1)
