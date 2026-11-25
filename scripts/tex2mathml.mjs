// Minimal LaTeX -> MathML converter for blog posts. No dependencies.
//
// MathML Core is rendered natively by current Chrome, Edge, Firefox and Safari, so
// formulas are converted at build time and the browser loads nothing extra.
//
// Supported subset (enough for engineering notes):
//   \frac{a}{b}  \sqrt{x}  \sqrt[n]{x}  x^{..}  x_{..}  {groups}
//   \text{..}  \mathrm{..}  \operatorname{..}  \left( .. \right)
//   Greek letters, \log \ln \sin \cos \tan \exp \max \min, common operators
//   (\cdot \times \approx \le \ge \ne \pm \to \infty \propto \sim \parallel ...)
//   spacing \, \; \quad \qquad
// Anything else throws, so a typo fails the build instead of shipping broken math.

const GREEK = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ϵ', varepsilon: 'ε', zeta: 'ζ', eta: 'η',
  theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π',
  rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'ϕ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
};
const OPS = {
  cdot: '·', times: '×', div: '÷', pm: '±', mp: '∓', approx: '≈', sim: '∼', simeq: '≃', propto: '∝',
  le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠', ll: '≪', gg: '≫', equiv: '≡',
  to: '→', rightarrow: '→', leftarrow: '←', Rightarrow: '⇒', infty: '∞', parallel: '∥', partial: '∂',
  sum: '∑', prod: '∏', int: '∫', degree: '°', ldots: '…', cdots: '⋯',
};
const FUNCS = new Set(['log', 'ln', 'lg', 'exp', 'sin', 'cos', 'tan', 'arcsin', 'arccos', 'arctan', 'max', 'min', 'arg', 'Re', 'Im']);
const SPACES = { ',': '0.1667em', ':': '0.2222em', ';': '0.2778em', ' ': '0.25em', quad: '1em', qquad: '2em' };
const DELIMS = { '(': '(', ')': ')', '[': '[', ']': ']', '|': '|', '.': '', '\\{': '{', '\\}': '}', '\\|': '‖' };

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function tokenize(src) {
  const t = [];
  for (let i = 0; i < src.length;) {
    const c = src[i];
    if (c === '\\') {
      const m = /^\\([A-Za-z]+|.)/.exec(src.slice(i));
      if (!m) throw new Error('dangling backslash');
      t.push({ cmd: m[1] });
      i += m[0].length;
    } else if (/\s/.test(c)) {
      i++;
    } else if (/[0-9]/.test(c)) {
      const m = /^[0-9]+(?:[.,][0-9]+)?/.exec(src.slice(i));
      t.push({ num: m[0] });
      i += m[0].length;
    } else {
      t.push({ ch: c });
      i++;
    }
  }
  return t;
}

export function texToMathML(src, display = false) {
  const tok = tokenize(src);
  let p = 0;
  const peek = () => tok[p];
  const fail = msg => { throw new Error(`${msg} in $${src}$`); };

  // Raw text up to the matching brace, for \text{...}.
  function rawGroup() {
    if (peek()?.ch !== '{') fail('expected {');
    // Re-scan the source: find this group's text by counting braces in the token stream.
    p++;
    let depth = 1, out = '';
    while (p < tok.length) {
      const t = tok[p++];
      if (t.ch === '{') depth++;
      if (t.ch === '}' && --depth === 0) return out;
      out += t.cmd ? (t.cmd === ' ' || t.cmd === ',' ? ' ' : '') : t.num ?? t.ch;
    }
    fail('unbalanced {');
  }

  function group() {
    if (peek()?.ch === '{') {
      p++;
      const body = seq('}');
      p++;
      return body.length === 1 ? body[0] : `<mrow>${body.join('')}</mrow>`;
    }
    return atom() ?? fail('missing argument');
  }

  function delim() {
    const t = tok[p++];
    if (!t) fail('missing delimiter');
    const k = t.ch ?? `\\${t.cmd}`;
    if (!(k in DELIMS)) fail(`bad delimiter ${k}`);
    return DELIMS[k] ? `<mo stretchy="true">${esc(DELIMS[k])}</mo>` : '';
  }

  function atom() {
    const t = tok[p];
    if (!t) return null;
    if (t.ch === '}' ) return null;
    p++;
    if (t.num) return `<mn>${t.num}</mn>`;
    if (t.ch) {
      if (t.ch === '{') { p--; return group(); }
      if (/[A-Za-z]/.test(t.ch)) return `<mi>${t.ch}</mi>`;
      if (t.ch === "'") return '<mo>′</mo>';
      if (t.ch === '^' || t.ch === '_') fail(`unexpected ${t.ch}`);
      return `<mo>${esc(t.ch)}</mo>`;
    }
    const c = t.cmd;
    if (c in GREEK) return `<mi>${GREEK[c]}</mi>`;
    if (c in OPS) return `<mo>${OPS[c]}</mo>`;
    if (c in SPACES) return `<mspace width="${SPACES[c]}"/>`;
    if (FUNCS.has(c)) return `<mi>${c}</mi>\u0002`; // marker: function name, scripts allowed
    switch (c) {
      case 'frac': return `<mfrac>${group()}${group()}</mfrac>`;
      case 'sqrt': {
        if (peek()?.ch === '[') {
          p++;
          const idx = seq(']'); p++;
          return `<mroot>${group()}<mrow>${idx.join('')}</mrow></mroot>`;
        }
        return `<msqrt>${group()}</msqrt>`;
      }
      case 'text': return `<mtext>${esc(rawGroup())}</mtext>`;
      case 'mathrm': case 'operatorname': return `<mi mathvariant="normal">${esc(rawGroup())}</mi>`;
      case 'left': return delim();
      case 'right': return delim();
      case '%': return '<mo>%</mo>';
      case '{': return '<mo>{</mo>';
      case '}': return '<mo>}</mo>';
      default: fail(`unsupported command \\${c}`);
    }
  }

  function seq(end) {
    const out = [];
    while (p < tok.length) {
      const t = peek();
      if (end && t.ch === end) return out;
      if (t.ch === '}' && end !== '}') fail('unbalanced }');
      let base = atom();
      if (base === null) break;
      const isFunc = base.endsWith('\u0002');
      if (isFunc) base = base.slice(0, -1);
      let sub = null, sup = null;
      while (peek()?.ch === '_' || peek()?.ch === '^') {
        const s = tok[p++].ch;
        const arg = group();
        if (s === '_') sub = arg; else sup = arg;
      }
      if (sub && sup) base = `<msubsup>${base}${sub}${sup}</msubsup>`;
      else if (sub) base = `<msub>${base}${sub}</msub>`;
      else if (sup) base = `<msup>${base}${sup}</msup>`;
      out.push(isFunc ? `${base}<mo>&#x2061;</mo>` : base);
    }
    if (end) fail(`missing ${end}`);
    return out;
  }

  const body = seq(null);
  if (p < tok.length) fail('unbalanced }');
  return `<math${display ? ' display="block"' : ''} alttext="${esc(src).replace(/"/g, '&quot;')}"><mrow>${body.join('')}</mrow></math>`;
}
