// Sy(m)phon-e : calculs de l'écran « Agent » (v2.38). Fonctions pures, testables sans écran. ARGENT FICTIF.
(function (g) {
  const DEPART = 1000;
  const heure = (x) => (x === null || x === undefined || x === "" ? null : (typeof x === "number" ? x : Date.parse(x)));
  const num = (x) => (x === null || x === undefined || x === "" || isNaN(Number(x)) ? null : Number(x));

  // Simulation de mise Kelly (règles de l'Analyse du 26/11, FIXÉES) : K4 = (1/4, 2 %), K8 = (1/8, 1 %)
  function simulerKelly(decisions, frac, plafond) {
    const liste = decisions.map((d) => ({
      id: d.id, match: String(d.hltv_match_id), decideT: heure(d.decide_le_utc), regleT: heure(d.regle_le),
      p: num(d.p_agent), c: num(d.cote_prise), statut: d.statut
    })).sort((a, b) => (a.decideT - b.decideT) || (a.id - b.id));
    const reglee = (x) => (x.statut === "gagne" || x.statut === "perdu" || x.statut === "annule") && x.regleT !== null;
    const parMatch = {};
    const lignes = [];
    liste.forEach((x, i) => {
      let banque = DEPART;
      for (let j = 0; j < i; j++) { const y = lignes[j]; if (y.reglee && y.regleT <= x.decideT) banque += y.gain; }
      let mise = 0, manquant = false;
      if (x.p === null || x.c === null || x.c <= 1) manquant = true;
      else {
        const f = (x.p * x.c - 1) / (x.c - 1);
        if (f > 0) {
          let m = Math.min(frac * f * banque, plafond * banque);
          if (m < 0.0025 * banque) m = 0.0025 * banque;
          const place = 0.04 * banque - (parMatch[x.match] || 0);
          mise = place < 0.0025 * banque ? 0 : Math.min(m, place);
        }
      }
      parMatch[x.match] = (parMatch[x.match] || 0) + mise;
      const rg = reglee(x);
      let gain = 0;
      if (rg) gain = x.statut === "gagne" ? mise * (x.c - 1) : (x.statut === "perdu" ? -mise : 0);
      lignes.push({ id: x.id, banque, mise, gain, reglee: rg, regleT: x.regleT, manquant, statut: x.statut });
    });
    const regl = lignes.filter((l) => l.reglee).sort((a, b) => a.regleT - b.regleT);
    let b = DEPART, pic = DEPART, creux = 0;
    const courbe = [{ t: null, banque: DEPART }];
    regl.forEach((l) => { b += l.gain; courbe.push({ t: l.regleT, banque: b }); if (b > pic) pic = b; const dd = (pic - b) / pic; if (dd > creux) creux = dd; });
    const placees = lignes.filter((l) => l.mise > 0);
    const parts = placees.map((l) => l.mise / l.banque);
    const attente = lignes.filter((l) => !l.reglee);
    return {
      lignes, courbe, banque: b, variation: b / DEPART - 1,
      miseMoyenne: parts.length ? parts.reduce((s, v) => s + v, 0) / parts.length : null,
      miseMax: parts.length ? Math.max.apply(null, parts) : null,
      creux, nbMiseNulle: lignes.filter((l) => l.mise === 0).length, nbManquant: lignes.filter((l) => l.manquant).length,
      attente: { n: attente.length, mises: attente.reduce((s, l) => s + l.mise, 0) }
    };
  }

  // Tranches fixes demandées par l'Analyse (chaque fonction renvoie [libellé, ordre])
  function trancheCote(c) {
    c = num(c); if (c === null) return ["inconnue", 99];
    if (c < 1.15) return ["moins de 1,15", 0]; if (c < 1.40) return ["1,15 – 1,40", 1]; if (c < 1.70) return ["1,40 – 1,70", 2];
    if (c < 2.00) return ["1,70 – 2,00", 3]; if (c < 2.50) return ["2,00 – 2,50", 4]; return ["plus de 2,50", 5];
  }
  function trancheProba(p) {
    p = num(p); if (p === null) return ["inconnue", 99];
    if (p < 0.70) return ["moins de 70 %", 0]; if (p < 0.80) return ["70 – 80 %", 1]; if (p < 0.90) return ["80 – 90 %", 2]; return ["90 % et plus", 3];
  }
  function trancheAvantage(p, c) {
    p = num(p); c = num(c); if (p === null || c === null || c <= 0) return ["inconnu", 99];
    const a = (p - 1 / c) * 100;
    if (a < 5) return ["moins de 5 points", 0]; if (a < 10) return ["5 – 10 points", 1]; if (a < 20) return ["10 – 20 points", 2]; return ["plus de 20 points", 3];
  }
  function sensDuPari(d) {
    const i = String(d.issue || "").trim().toLowerCase();
    if (/^(plus|over|\+)/.test(i)) return ["plus", 0];
    if (/^(moins|under|-)/.test(i)) return ["moins", 1];
    if (d.equipe_pariee && d.equipe_pariee === d.equipe1) return ["équipe 1", 2];
    if (d.equipe_pariee && d.equipe_pariee === d.equipe2) return ["équipe 2", 3];
    return [d.issue ? String(d.issue) : "inconnu", 9];
  }
  function situationScore(d) {
    const s1 = num(d.score_e1), s2 = num(d.score_e2);
    if (s1 === null || s2 === null || !d.equipe_pariee) return ["inconnu", 9];
    const ecart = d.equipe_pariee === d.equipe1 ? s1 - s2 : (d.equipe_pariee === d.equipe2 ? s2 - s1 : null);
    if (ecart === null) return ["inconnu", 9];
    return ecart > 0 ? ["l'équipe pariée mène", 0] : (ecart === 0 ? ["égalité", 1] : ["l'équipe pariée est menée", 2]);
  }
  function brut(x, avant) { return x === null || x === undefined || x === "" ? [avant || "inconnu", 99] : [String(x), 0]; }

  const LECTURES = [
    ["moment", "Moment", (d) => d.moment === "en_direct" ? ["En direct", 1] : (d.moment === "avant_match" ? ["Avant match", 0] : ["inconnu", 9])],
    ["marche", "Marché", (d) => brut(d.marche)],
    ["tournoi", "Tournoi", (d) => brut(d.tournoi)],
    ["palier", "Palier", (d) => d.tier ? ["Palier " + String(d.tier).toUpperCase(), 0] : ["Palier —", 99]],
    ["cote", "Cote prise", (d) => trancheCote(d.cote_prise)],
    ["proba", "Probabilité de l'agent", (d) => trancheProba(d.p_agent)],
    ["avantage", "Avantage", (d) => trancheAvantage(d.p_agent, d.cote_prise)],
    ["round", "Round de décision", (d) => d.round_decision === null || d.round_decision === undefined ? ["avant match", -1] : ["R" + d.round_decision, Number(d.round_decision)]],
    ["sens", "Sens du pari", sensDuPari],
    ["score", "Situation de score", situationScore],
    ["carte", "Carte", (d) => brut(d.nom_carte)],
    ["numero", "Numéro de carte", (d) => d.carte === null || d.carte === undefined ? ["inconnu", 99] : (Number(d.carte) === 0 ? ["match entier", -1] : ["carte " + d.carte, Number(d.carte)])],
    ["format", "Format", (d) => d.bo ? ["BO" + d.bo, Number(d.bo)] : ["inconnu", 99]]
  ];

  function ajouter(a, d) {
    a.n++;
    if (d.statut === "gagne" || d.statut === "perdu") {
      a.termines++; if (d.statut === "gagne") a.gagnes++;
      a.gain += num(d.gain_unites) || 0; a.mises += num(d.mise_unites) || 0;
    } else if (d.statut === "annule") a.annules++; else a.attente++;
  }
  const vide = () => ({ n: 0, termines: 0, gagnes: 0, annules: 0, attente: 0, gain: 0, mises: 0 });
  const roi = (a) => (a.mises > 0 ? a.gain / a.mises : null);

  function agreger(decisions, fonction) {
    const m = {};
    decisions.forEach((d) => { const [lib, ordre] = fonction(d); const k = lib; if (!m[k]) { m[k] = vide(); m[k].libelle = lib; m[k].ordre = ordre; } ajouter(m[k], d); });
    return Object.keys(m).map((k) => m[k]).sort((a, b) => (a.ordre - b.ordre) || String(a.libelle).localeCompare(String(b.libelle), "fr"));
  }
  function total(decisions) { const a = vide(); decisions.forEach((d) => ajouter(a, d)); return a; }

  // Gain cumulé (mise plate) par jour de règlement, dans l'ordre des jours
  function gainParJour(decisions) {
    const j = {};
    decisions.forEach((d) => {
      if ((d.statut === "gagne" || d.statut === "perdu") && d.regle_le) {
        const k = new Date(d.regle_le).toLocaleDateString("fr-CA", { timeZone: "Europe/Paris" });
        j[k] = (j[k] || 0) + (num(d.gain_unites) || 0);
      }
    });
    let c = 0;
    return Object.keys(j).sort().map((k) => { c += j[k]; return { jour: k, gain: j[k], cumul: c }; });
  }

  g.AgentCalcul = { DEPART, simulerKelly, agreger, total, roi, gainParJour, LECTURES };
  if (typeof module !== "undefined" && module.exports) module.exports = g.AgentCalcul;
})(typeof window !== "undefined" ? window : globalThis);
