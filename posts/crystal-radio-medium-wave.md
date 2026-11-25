---
title: A crystal radio for medium wave, and a variable capacitor that is too small
date: 2026-11-25
tags: [crystal-radio, am, medium-wave, nanovna, rf]
status: draft
summary: Building an unpowered AM receiver in Vigo, why a 20-140 pF variable cannot tune the whole medium wave band with one coil, and how a tapped coil, a band switch and a NanoVNA fix it.
---

<figure>
<div class="placeholder wide">Photo pending: the finished crystal radio</div>
<figcaption><b>Figure 1.</b> The finished receiver. TODO: cover photo.</figcaption>
</figure>

A crystal radio has no battery and no amplifier. Every microwatt that reaches the earpiece was radiated by the transmitter and collected by a piece of wire. That makes it the most honest receiver you can build: nothing hides a lossy coil, a bad ground or a poorly matched detector. You hear it immediately.

This is the build log of one I made to listen to AM broadcasting on medium wave from Vigo. The interesting part is not the circuit, which is a century old, but a design constraint: the only variable capacitor I had tunes from 20 to 140 pF, and that is not enough to cover the band with a single coil.

## The circuit

The signal path is short:

1. A **long wire antenna** and a good **earth**.
2. A **tuned LC tank** that selects one station and builds up its voltage.
3. A **detector** (galena with a cat's whisker, or a germanium or Schottky diode) that rectifies the AM signal.
4. A **high impedance earpiece** that turns the recovered audio into sound.

<figure class="schematic">
<img src="img/crystal-radio/crystal-radio-schematic.svg" alt="Schematic: long wire antenna to tap A of L1, band switch S1 selecting the full coil or tap B, variable capacitor C1 to ground, detector D1 from tap D to a piezo earpiece with R1 in parallel" loading="lazy">
<figcaption><b>Figure 2.</b> The receiver. S1 selects the whole coil (low band) or tap B (high band). The antenna and the detector connect to low taps to keep the tank's Q high. Tap positions are drawn schematically, see the table further down.</figcaption>
</figure>

The tank resonates where the reactances of L and C cancel:

$$
f = \frac{1}{2\pi\sqrt{LC}}
$$

At resonance the tank looks like a large resistance, the dynamic resistance $R_D = Q\omega L$, and the station's voltage is at its maximum. Off resonance the tank is a low impedance and other stations are shunted to ground. How sharp that selection is depends on Q, the ratio between the energy stored in the tank and the energy lost per cycle.

A few details that matter more than they seem:

- **The rotor of C1 goes to ground.** The rotor is connected to the shaft and to your hand when you tune. With the rotor grounded, touching the knob does not detune the receiver.
- **R1 across the piezo earpiece.** A piezo earpiece is a capacitor for DC. Without a resistive path, the diode charges it to the peak of the carrier and stops conducting, and the audio disappears. 47-100 kΩ gives the DC a way home without loading the circuit too much.
- **The detector sits on a tap, not on the top of the coil.** More on this below.

### Why the taps

At 1 MHz the full coil has a reactance of $\omega L \approx 3.7$ kΩ. With an unloaded Q of 150, the dynamic resistance of the tank is about 560 kΩ. The detector and earpiece, on the other hand, look like a few tens of kΩ. Connected straight across the tank they would drop Q by an order of magnitude, and every strong station would be heard everywhere on the dial.

A tap works like an autotransformer. A load $R$ connected at $n$ turns of an $N$ turn coil is seen by the whole tank as:

$$
R_{\text{seen}} \approx R\left(\frac{N}{n}\right)^2
$$

Tapping the detector at a quarter of the turns multiplies its apparent resistance by about 16. The antenna gets the same treatment: a long wire is a lossy, capacitive source that would also load and detune the tank. The relation is approximate because the turns of a single layer solenoid are not perfectly coupled, so the best taps are found by listening and measuring.

## The problem: 20-140 pF is not enough

Medium wave broadcasting in Europe (ITU Region 1) uses 9 kHz channels from **531 to 1602 kHz**. That is a frequency ratio of about 3:1.

Since $f \propto 1/\sqrt{C}$, the tuning range of a tank with a variable capacitor is:

$$
\frac{f_{\text{max}}}{f_{\text{min}}} = \sqrt{\frac{C_{\text{max}} + C_s}{C_{\text{min}} + C_s}}
$$

where $C_s$ is the stray capacitance: the coil's self capacitance, wiring, switch and detector. It adds to both ends of the variable range and always compresses the ratio.

| | Value |
|---|---|
| Variable capacitor C1 | 20-140 pF |
| Stray capacitance $C_s$ (estimated) | ~15 pF (TODO: measured value) |
| Effective tuning capacitance | 35-155 pF |
| Capacitance ratio | 4.4:1 |
| Frequency ratio | **2.1:1** |
| Needed for 531-1602 kHz | 3.0:1 in frequency, **9.1:1** in capacitance |

A single coil covers roughly 2.1:1, for example 525-1106 kHz, and the top third of the band is out of reach. Two bands are needed.

### Why switch the inductance and not add a capacitor

The obvious fix is to keep a smaller coil for the top of the band and switch a fixed capacitor $C_p$ in parallel with C1 for the bottom. It does not work well, because the fixed capacitor dilutes the variable:

$$
\frac{f_{\text{max}}}{f_{\text{min}}} = \sqrt{\frac{C_{\text{max}} + C_s + C_p}{C_{\text{min}} + C_s + C_p}}
$$

With the 186 µH coil that covers the top of the band (938-1973 kHz), reaching 531 kHz needs 483 pF in total, so $C_p \approx 328$ pF. The tuning range becomes 363-483 pF, a ratio of 1.33:1 in capacitance and only **531-612 kHz** in frequency. There is a hole from 612 to 938 kHz.

Changing L instead keeps the full 4.4:1 capacitance ratio on every band, and each band simply slides along the dial. That is why the receiver uses a tapped coil and a band switch.

## The coil

The coil is close wound on a cardboard tube:

- **Former:** cardboard tube, ~50 mm outside diameter, dried and varnished. Cardboard absorbs moisture, and damp cardboard is a lossy dielectric right where the coil's electric field is strongest.
- **Wire:** 0.4 mm enamelled copper, close wound. The enamel makes the real pitch ~0.43 mm per turn.
- **Turns:** ~140, a winding ~60 mm long that takes about 22 m of wire.
- **Taps:** loops left at several turns, counted from the ground end, to choose the best one after measuring.

<figure>
<div class="placeholder">Photo pending: winding the coil on the cardboard former</div>
<figcaption><b>Figure 3.</b> Winding the coil. TODO: process photo.</figcaption>
</figure>

### How much inductance

For a single layer air core solenoid, Wheeler's formula (1928) is accurate to about 1% when the coil is longer than 0.8 times its radius:

$$
L = \frac{r^2 N^2}{9r + 10l}
$$

with $L$ in µH, the mean radius $r$ and the winding length $l$ in inches, and $N$ turns. Here $r = 25.2$ mm (0.99 in), measured to the centre of the wire. For 140 turns, $l = 60.2$ mm (2.37 in):

$$
L = \frac{0.99^2 \times 140^2}{9 \times 0.99 + 10 \times 2.37} \approx 590\ \text{µH}
$$

The same formula gives the inductance up to each tap. When S1 selects a tap, the turns above it are left open and carry no current, so to a first approximation only the turns below the tap count.

| Section | Length | L (Wheeler) | Band with 35-155 pF |
|---|---:|---:|---:|
| Full coil, 140 turns | 60.2 mm | ~590 µH | ~525-1106 kHz |
| Tap at 60 turns | 25.8 mm | ~186 µH | ~938-1973 kHz |
| Tap at 68 turns | 29.2 mm | ~223 µH | ~856-1802 kHz |
| Tap at 78 turns | 33.5 mm | ~271 µH | ~777-1635 kHz |

All of these are estimates. Wheeler is accurate for the ideal coil, but the real one has a cardboard former, slightly uneven turns and a stray capacitance that is itself a guess, so 5-10% errors in the predicted band edges are normal. The 78 turn tap overlaps the low band generously but only just reaches 1602 kHz, the 60 turn tap has plenty of margin at the top but leaves a narrow overlap at the bottom. That is exactly why the tap was chosen by measurement.

TODO: which tap was finally used and why.

The unused turns above the tap are not entirely harmless. They form a resonant circuit with their own self capacitance and can absorb energy at some frequency. With a short dead end this resonance sits well above the band, but it is one more reason to measure.

## Measuring with the NanoVNA

A NanoVNA is a small vector network analyzer that covers medium wave comfortably. It measures the coil and capacitor separately and the tank as a whole, and gives the inductance, the real band edges and the Q.

### Calibration

Before any measurement the NanoVNA is calibrated at the end of the cables that will touch the circuit, the reference plane. The standard procedure is **SOLT**:

- **Short**, **Open** and **Load** (50 Ω) on CH0, which define the reflection measurement.
- **Thru**, CH0 connected to CH1, which defines the transmission measurement.
- **Isolation**, a load on each port, which removes the leakage between the two channels.

The sweep is set to cover the band with some margin, TODO: span used. At these frequencies a few centimetres of lead hardly matter, but the leads should be the same ones used for the measurement. TODO: how the SMA was connected to the circuit (pigtail, clips, test fixture).

### Method 1: S21 with weak capacitive coupling

This is the method that gives the unloaded Q:

<figure class="schematic">
<img src="img/crystal-radio/nanovna-s21-setup.svg" alt="NanoVNA CH0 and CH1 centre conductors each connected through a 1-2 pF capacitor to the hot node of the LC tank, shields to the tank's ground end" loading="lazy">
<figcaption><b>Figure 4.</b> S21 measurement. Each port couples to the hot node through 1-2 pF, and both shields go to the ground end of the tank.</figcaption>
</figure>

At 1 MHz a 1.5 pF capacitor has a reactance of about 100 kΩ, so the 50 Ω ports barely touch the tank. Off resonance almost nothing gets from CH0 to CH1. At resonance the tank's impedance peaks and S21 shows a peak.

The height of the peak tells you how weak the coupling is. It should sit **20-30 dB below 0 dB**. If it is higher, the ports are loading the tank and the measured Q is too low. In that case use smaller capacitors or move them further apart.

The loaded Q comes from the -3 dB bandwidth of the peak:

$$
Q_L = \frac{f_0}{f_2 - f_1}
$$

and, with the same coupling on both ports, the unloaded Q follows from the peak transmission, $S_{21}$ in dB:

$$
Q_U = \frac{Q_L}{1 - 10^{S_{21}/20}}
$$

At -30 dB the correction is 3%, at -20 dB it is 11%. One more correction matters here: the two coupling capacitors add 2-4 pF to the tank. At the top of the dial, where the tank has only 35 pF, that lowers the resonance by up to about 5%.

### Method 2: S11 with a coupling loop

A small loop of wire on CH0, held near the coil without touching it, behaves like a dip meter. S11 shows a dip at resonance. Nothing is connected to the circuit, so the antenna and the detector can stay in place, which makes it the way to see how much the antenna shifts and broadens the resonance.

### Method 3: direct S11

Connecting CH0 straight across the tank gives a reliable resonant frequency, where the reactance crosses zero. The Q is useless, though, because 50 Ω in parallel with hundreds of kΩ swamps the tank.

### Method 4: L and C separately

- **The coil alone**, swept at low frequency where its reactance is purely inductive: $L = X / (2\pi f)$. Sweeping higher shows its self resonant frequency, from which the self capacitance can be estimated.
- **The variable capacitor alone**, measured at both ends of its travel.
- **The tank**, with a known capacitor at resonance $f_0$, gives the inductance:

$$
L = \frac{1}{(2\pi f_0)^2 C}
$$

<figure>
<div class="placeholder">Photo pending: the NanoVNA measurement setup</div>
<figcaption><b>Figure 5.</b> Measurement setup on the bench. TODO: photo.</figcaption>
</figure>

<figure>
<div class="placeholder">Photo pending: NanoVNA screen showing the resonance peak</div>
<figcaption><b>Figure 6.</b> NanoVNA screen at resonance. TODO: screenshot.</figcaption>
</figure>

<figure>
<div class="placeholder wide">Plot pending: S21 magnitude around resonance, low and high band, from the NanoVNA Touchstone export</div>
<figcaption><b>Figure 7.</b> Measured S21 of the tank. TODO: export the sweeps (Touchstone .s2p or CSV) to generate this plot.</figcaption>
</figure>

### Results

| Quantity | Estimated | Measured |
|---|---|---|
| L, full coil | ~590 µH | TODO |
| L at the chosen tap | 186-271 µH | TODO |
| C1 minimum / maximum | 20 / 140 pF | TODO |
| Stray capacitance | ~15 pF | TODO |
| Low band | ~525-1106 kHz | TODO |
| High band | depends on the tap | TODO |
| Unloaded Q | 100-200 expected | TODO |
| Shift when the antenna is connected | - | TODO |
| Self resonant frequency of the coil | - | TODO |

For reference, a Q of 150 at 1 MHz means a -3 dB bandwidth of 6.7 kHz, less than one 9 kHz channel. In use, the antenna and the detector lower that Q, which is why their taps are a compromise between selectivity and volume.

## Taps and components used

| Item | Value |
|---|---|
| Antenna tap A | TODO turns |
| Detector tap D | TODO turns |
| Band tap B | TODO turns |
| Detector | TODO: galena, germanium (OA90, 1N34A) or Schottky (BAT85) |
| Earpiece | Piezo, high impedance, R1 = TODO kΩ |
| Antenna | Long wire, TODO m, height TODO m |
| Earth | TODO |
| Tuning knob | TODO: 3D printed shaft adapter and knob? |

<figure>
<div class="placeholder">Photo pending: the variable capacitor and its knob</div>
<figcaption><b>Figure 8.</b> The 20-140 pF variable capacitor. TODO: photo.</figcaption>
</figure>

<figure>
<div class="placeholder">Photo pending: detector close-up</div>
<figcaption><b>Figure 9.</b> The detector. TODO: photo.</figcaption>
</figure>

## On the air from Vigo

These are the medium wave stations listed for the area. They still have to be confirmed with an SDR sweep of the band before trusting the list.

| Station | Frequency | Verified on SDR | Heard on the crystal set |
|---|---:|---|---|
| Radio Vigo (Cadena SER) | 1026 kHz | TODO | TODO |
| RNE Vigo | 1413 kHz | TODO | TODO |
| RNE Pontevedra | 531 kHz | TODO | TODO |
| RNE Pontevedra | 855 kHz | TODO | TODO |

TODO: what is heard by day and by night. At night, sky wave propagation brings in distant stations that can overpower the weak local ones.

<figure>
<div class="placeholder wide">Plot pending: SDR sweep of the medium wave band from Vigo</div>
<figcaption><b>Figure 10.</b> The medium wave band seen from Vigo. TODO: optional SDR capture.</figcaption>
</figure>

<figure>
<div class="placeholder">Photo pending: coil with its taps</div>
<figcaption><b>Figure 11.</b> The finished coil with its tap loops. TODO: photo.</figcaption>
</figure>

## Lessons and possible improvements

- **Litz wire.** At medium wave, skin and proximity effects in a close wound coil make the resistance of solid wire a few times its DC value. Litz wire, many insulated strands woven together, can raise the coil's Q substantially in this range.
- **A better former.** PVC or polystyrene tube instead of cardboard: lower dielectric loss and no sensitivity to humidity.
- **Spaced or basket weave winding.** Less self capacitance, which extends the tuning ratio, and lower proximity losses.
- **A variometer.** Tuning by varying the inductance (a rotating coil inside a fixed one) instead of switching bands.
- **Two tuned circuits.** A second tank coupled to the first improves selectivity a lot, at the cost of some volume.
- **A larger variable capacitor.** A 365 or 500 pF variable would cover the band with a single coil and no switch.

## References

1. H. A. Wheeler, "Simple Inductance Formulas for Radio Coils", *Proceedings of the IRE*, vol. 16, no. 10, pp. 1398-1400, October 1928.
2. D. Kajfez, *Q Factor Measurements Using MATLAB*, Artech House, 2011. Unloaded Q from transmission measurements.
3. ITU, Regional Agreement GE75: LF/MF broadcasting in Regions 1 and 3, 9 kHz channel raster.
4. Ben H. Tongue, articles on crystal set design and detector matching (bentongue.com).
5. NanoVNA user guide, [nanovna.com](https://nanovna.com/).
