---
title: Hello, noise
date: 2026-11-22
tags: [meta, noise, dsp]
status: published
summary: What this notebook is about, how the site is built, and the one number every receiver starts from: −174 dBm/Hz.
---

This is my notebook on software defined radio: signal processing experiments, small tools and notes on the spectrum around me. Everything here runs in your browser. There is no backend, no tracking and no framework, just one HTML file and a handful of static JSON and TLE files refreshed by scheduled jobs.

## Starting from the floor

Every link budget I write starts from the same place: the thermal noise power available from a matched resistor at the reference temperature T₀ = 290 K.

$$
N = k·T₀·B   →   10·log₁₀(k·T₀·1 Hz / 1 mW) ≈ −173.98 dBm/Hz
$$

Add the equivalent noise bandwidth and the receiver noise figure and you have the floor:

```python
import numpy as np

k = 1.380649e-23          # J/K
T0 = 290.0                # K

def noise_floor_dbm(bw_hz, nf_db):
    return 10 * np.log10(k * T0 * bw_hz * 1e3) + nf_db

print(noise_floor_dbm(12.5e3, 6))   # NFM channel, 6 dB NF  -> about -127 dBm
```

Two caveats I keep in mind:

- B is the *equivalent noise bandwidth* of the filter, not its −3 dB width. For an FFT bin it is the bin width times the ENBW of the window (1.5 bins for Hann).
- Below about 30 MHz the antenna brings much more than kT₀B. External noise (atmospheric, galactic, man-made) dominates and a low-NF front end buys almost nothing. ITU-R P.372 has the curves.

## What is here

| Section | What it does |
|---|---|
| RF Calculators | Path loss, noise, cascades, mismatch, Hata/COST-231. Each one states its model and validity range. |
| Frequency DB | ITU Region 1 allocations and notable signals, with notes for Spain. |
| Satellites | Ground tracks and look angles from TLE sets. |
| Propagation | Solar/geomagnetic indices and quick HF estimates. |
| WebSDR | An RTL-SDR receiver over WebUSB, in progress. |

The calculators are live now; the rest is filling in over the next posts.
