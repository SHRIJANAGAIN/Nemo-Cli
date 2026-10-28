#!/usr/bin/env python3
"""
Shrijan - Repetition Control
================================
Four-level repetition detector + cut-and-retry controller.

Level 1 — Token repetition
  Same token appears N+ times consecutively or with too-high global frequency.
  Legitimate repetition in code (e.g. `for item in items`) is allowed by
  detecting "code-like" contexts (indented blocks, balanced brackets).

Level 2 — N-gram repetition
  Same 2, 3, 4, 5-token sequence appears 3+ times. Triggers cut.

Level 3 — Sentence repetition
  Identical or near-identical sentences appear 2+ times. Triggers cut.

Level 4 — Semantic repetition
  Sentences with cosine similarity > 0.7 (TF-IDF fallback) appear 2+ times.
  Triggers cut.

The controller never just stops — it marks GENERATION_FAILURE, cuts the
output at the first repeated sentence, and asks the runtime to retry
with a different decoding temperature or a refined prompt.
"""

from __future__ import annotations

import argparse
import collections
import dataclasses
import json
import math
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

WORD_RE = re.compile(r"\b[\w']+\b", re.UNICODE)
SENTENCE_RE = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9\"'])|\n{2,}")

STOPWORDS = set("""
a an the and or but if then so of in on at to for from with by as is are was were be been being
this that these those it its i you he she we they me him her them my our your his their
do does did doing have has had having will would can could should may might shall
not no nor very much more most less least just only also even still already
""".split())

CODE_LINE_RE = re.compile(r"^\s*(for |while |if |elif |else|return|print|console\.|echo|fn |def |class )")
INDENT_BLOCK_RE = re.compile(r"^\s{2,}\S")


# ---------------------------------------------------------------------------
# L1: Token repetition
# ---------------------------------------------------------------------------


@dataclass
class TokenRepetitionReport:
    """L1 token repetition report."""
    total_tokens: int
    unique_tokens: int
    ratio: float
    top_offenders: List[Tuple[str, int]]
    max_consecutive_run: int
    max_consecutive_token: str
    is_code_context: bool
    triggered: bool

    def to_dict(self) -> Dict[str, Any]:
        return dataclasses.asdict(self)


def _is_code_context(text: str, pos: int) -> bool:
    """Heuristic: is this token inside a code block?"""
    line_start = text.rfind("\n", 0, pos) + 1
    line = text[line_start:text.find("\n", pos) if "\n" in text[pos:] else len(text)]
    if CODE_LINE_RE.match(line):
        return True
    if INDENT_BLOCK_RE.match(line):
        return True
    if line.lstrip().startswith(("#", "//", "/*", "*", "<!--")):
        return False
    return False


def detect_token_repetition(text: str, threshold: float = 0.5, code_aware: bool = True) -> TokenRepetitionReport:
    """L1 — detect excessive token repetition. Code lines are exempt."""
    if not text:
        return TokenRepetitionReport(0, 0, 0.0, [], 0, "", False, False)
    tokens: List[Tuple[str, int]] = []  # (token, is_code)
    for m in WORD_RE.finditer(text):
        tok = m.group(0).lower()
        if tok in STOPWORDS or len(tok) <= 2:
            continue
        in_code = code_aware and _is_code_context(text, m.start())
        tokens.append((tok, in_code))
    considered = [t for t, c in tokens if not c]
    total = len(considered)
    if total == 0:
        return TokenRepetitionReport(0, 0, 0.0, [], 0, "", True, False)
    counter = collections.Counter(considered)
    unique = len(counter)
    ratio = (total - unique) / total
    top = counter.most_common(5)
    # Consecutive run
    max_run = 0
    cur_run = 0
    cur_token = ""
    max_token = ""
    for tok, _ in tokens:
        if tok == cur_token:
            cur_run += 1
        else:
            if cur_run > max_run:
                max_run = cur_run
                max_token = cur_token
            cur_run = 1
            cur_token = tok
    if cur_run > max_run:
        max_run = cur_run
        max_token = cur_token
    triggered = ratio > threshold or max_run >= 6
    return TokenRepetitionReport(
        total_tokens=total,
        unique_tokens=unique,
        ratio=round(ratio, 4),
        top_offenders=top,
        max_consecutive_run=max_run,
        max_consecutive_token=max_token,
        is_code_context=code_aware,
        triggered=triggered,
    )


# ---------------------------------------------------------------------------
# L2: N-gram repetition
# ---------------------------------------------------------------------------


@dataclass
class NgramRepetitionReport:
    """L2 n-gram repetition report."""
    n_sizes: List[int]
    repeated_ngrams: Dict[int, List[Tuple[str, int]]]
    triggered: bool

    def to_dict(self) -> Dict[str, Any]:
        return dataclasses.asdict(self)


def detect_ngram_repetition(text: str, ns: List[int] = (2, 3, 4, 5), min_occurrences: int = 3) -> NgramRepetitionReport:
    """L2 — detect repeated n-grams across the whole response."""
    tokens = [m.group(0).lower() for m in WORD_RE.finditer(text)]
    tokens = [t for t in tokens if t not in STOPWORDS and len(t) > 1]
    repeated: Dict[int, List[Tuple[str, int]]] = {}
    triggered = False
    for n in ns:
        if len(tokens) < n:
            continue
        ngrams = [" ".join(tokens[i:i + n]) for i in range(len(tokens) - n + 1)]
        counter = collections.Counter(ngrams)
        hits = [(g, c) for g, c in counter.most_common() if c >= min_occurrences]
        repeated[n] = hits
        if hits:
            triggered = True
    return NgramRepetitionReport(n_sizes=list(ns), repeated_ngrams=repeated, triggered=triggered)


# ---------------------------------------------------------------------------
# L3: Sentence repetition
# ---------------------------------------------------------------------------


@dataclass
class SentenceRepetitionReport:
    """L3 sentence repetition report."""
    sentences: List[str]
    repeated: List[Tuple[str, int]]
    triggered: bool
    cut_at_index: int  # 0-based sentence index where to cut (len if no cut)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "sentences_count": len(self.sentences),
            "repeated": [{"text": t, "count": c} for t, c in self.repeated],
            "triggered": self.triggered,
            "cut_at_index": self.cut_at_index,
        }


def _split_sentences(text: str) -> List[str]:
    return [s.strip() for s in SENTENCE_RE.split(text or "") if s.strip()]


def detect_sentence_repetition(text: str, min_occurrences: int = 2) -> SentenceRepetitionReport:
    """L3 — detect identical/near-identical sentences."""
    sentences = _split_sentences(text)
    norm = [" ".join(WORD_RE.findall(s)).lower() for s in sentences]
    counter = collections.Counter(norm)
    repeated: List[Tuple[str, int]] = []
    cut_at = len(sentences)
    for i, (n, c) in enumerate(counter.most_common()):
        if c >= min_occurrences and len(n) > 10:
            repeated.append((n, c))
            # Cut at the second occurrence
            seen = 0
            for j, ns in enumerate(norm):
                if ns == n:
                    seen += 1
                    if seen >= min_occurrences and j < cut_at:
                        cut_at = j
    triggered = bool(repeated)
    return SentenceRepetitionReport(
        sentences=sentences,
        repeated=repeated[:10],
        triggered=triggered,
        cut_at_index=cut_at,
    )


# ---------------------------------------------------------------------------
# L4: Semantic repetition (TF-IDF cosine, no external deps)
# ---------------------------------------------------------------------------


@dataclass
class SemanticRepetitionReport:
    """L4 semantic repetition report."""
    pairwise_similarities: List[Tuple[int, int, float]]
    clusters: List[List[int]]
    triggered: bool
    cut_at_index: int

    def to_dict(self) -> Dict[str, Any]:
        return {
            "pair_count": len(self.pairwise_similarities),
            "top_pairs": [{"i": i, "j": j, "cosine": round(c, 4)} for i, j, c in self.pairwise_similarities[:10]],
            "clusters": self.clusters,
            "triggered": self.triggered,
            "cut_at_index": self.cut_at_index,
        }


def _tfidf_vectors(sentences: List[str]) -> Tuple[List[Dict[int, float]], List[int]]:
    """Compute TF-IDF vectors as sparse dicts. Vocabulary index, IDF weights."""
    tokenized: List[List[str]] = []
    df: collections.Counter = collections.Counter()
    for s in sentences:
        toks = [t for t in WORD_RE.findall(s.lower()) if t not in STOPWORDS and len(t) > 1]
        tokenized.append(toks)
        for t in set(toks):
            df[t] += 1
    vocab = {t: i for i, t in enumerate(df)}
    n = max(1, len(sentences))
    idf = {t: math.log((n + 1) / (df_t + 1)) + 1 for t, df_t in df.items()}
    vectors: List[Dict[int, float]] = []
    for toks in tokenized:
        tf = collections.Counter(toks)
        if not tf:
            vectors.append({})
            continue
        norm = math.sqrt(sum(((c / len(toks)) * idf.get(t, 0)) ** 2 for t, c in tf.items())) or 1.0
        v = {vocab[t]: (c / len(toks)) * idf.get(t, 0) / norm for t, c in tf.items() if t in vocab}
        vectors.append(v)
    return vectors, list(idf.keys())


def _cosine(a: Dict[int, float], b: Dict[int, float]) -> float:
    if not a or not b:
        return 0.0
    keys = set(a) & set(b)
    return sum(a[k] * b[k] for k in keys)


def detect_semantic_repetition(text: str, threshold: float = 0.7) -> SemanticRepetitionReport:
    """L4 — cluster semantically similar sentences via TF-IDF cosine."""
    sentences = _split_sentences(text)
    vectors, _ = _tfidf_vectors(sentences)
    pairs: List[Tuple[int, int, float]] = []
    for i in range(len(sentences)):
        for j in range(i + 1, len(sentences)):
            c = _cosine(vectors[i], vectors[j])
            if c >= threshold:
                pairs.append((i, j, c))
    pairs.sort(key=lambda t: -t[2])
    # Union-find clustering
    parent = list(range(len(sentences)))
    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    for i, j, _ in pairs:
        ri, rj = find(i), find(j)
        if ri != rj:
            parent[ri] = rj
    clusters_dict: Dict[int, List[int]] = {}
    for i in range(len(sentences)):
        clusters_dict.setdefault(find(i), []).append(i)
    clusters = [c for c in clusters_dict.values() if len(c) >= 2]
    # Cut at the first sentence in the largest cluster that isn't the first occurrence
    cut_at = len(sentences)
    for cluster in clusters:
        if len(cluster) >= 2:
            cut_at = min(cut_at, cluster[1])
    triggered = bool(pairs)
    return SemanticRepetitionReport(
        pairwise_similarities=pairs,
        clusters=clusters,
        triggered=triggered,
        cut_at_index=cut_at,
    )


# ---------------------------------------------------------------------------
# Cut + retry controller
# ---------------------------------------------------------------------------


@dataclass
class RepetitionControllerResult:
    """Combined repetition control decision."""
    response: str
    original_chars: int
    final_chars: int
    cut_at: int
    triggered: bool
    decision: str  # "pass" | "cut" | "retry"
    levels: Dict[str, Any]
    retry_prompt_suffix: str
    new_temperature: float
    notes: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return dataclasses.asdict(self)


def control(
    response: str,
    token_threshold: float = 0.5,
    ngram_min: int = 3,
    sentence_min: int = 2,
    semantic_threshold: float = 0.7,
    base_temperature: float = 0.7,
) -> RepetitionControllerResult:
    """Run all four levels and return cut/retry decision.

    Decision policy:
      - L1 or L2 triggered → cut + retry (most aggressive)
      - L3 triggered → cut at first repeat
      - L4 triggered → cut at first semantic cluster non-leader
      - All clean → pass
    """
    l1 = detect_token_repetition(response, threshold=token_threshold)
    l2 = detect_ngram_repetition(response, min_occurrences=ngram_min)
    l3 = detect_sentence_repetition(response, min_occurrences=sentence_min)
    l4 = detect_semantic_repetition(response, threshold=semantic_threshold)

    levels = {
        "L1_token": l1.to_dict(),
        "L2_ngram": l2.to_dict(),
        "L3_sentence": l3.to_dict(),
        "L4_semantic": l4.to_dict(),
    }

    notes: List[str] = []
    decision = "pass"
    cut_at = len(response)
    new_temp = base_temperature

    # L1 — token repetition
    if l1.triggered:
        decision = "retry"
        new_temp = min(1.2, base_temperature + 0.2)
        notes.append(f"L1 token rep ratio={l1.ratio} top={l1.top_offenders[:3]}")
    # L2 — n-gram repetition
    if l2.triggered:
        decision = "retry"
        new_temp = min(1.4, base_temperature + 0.3)
        # Find first n-gram repeat position
        toks = [m.group(0).lower() for m in WORD_RE.finditer(response)]
        toks = [t for t in toks if t not in STOPWORDS and len(t) > 1]
        for n, hits in l2.repeated_ngrams.items():
            if not hits:
                continue
            gram = hits[0][0].split()
            target = " ".join(gram)
            for i in range(len(toks) - len(gram)):
                if " ".join(toks[i:i + len(gram)]) == target:
                    char_pos = sum(len(t) + 1 for t in toks[:i])
                    if char_pos < cut_at:
                        cut_at = char_pos
                    break
        notes.append(f"L2 n-gram rep sizes={l2.n_sizes}")
    # L3 — sentence repetition
    if l3.triggered:
        if decision == "pass":
            decision = "cut"
        # Find char position of the first repeated sentence
        if l3.cut_at_index < len(l3.sentences):
            target = l3.sentences[l3.cut_at_index]
            pos = response.find(target)
            if pos > 0 and pos < cut_at:
                cut_at = pos
        notes.append(f"L3 sentence rep count={len(l3.repeated)}")
    # L4 — semantic repetition
    if l4.triggered:
        if decision == "pass":
            decision = "cut"
        if l4.cut_at_index < len(l4.clusters) and l4.clusters[l4.cut_at_index]:
            idx = l4.clusters[l4.cut_at_index][1] if len(l4.clusters[l4.cut_at_index]) > 1 else l4.cut_at_index
            sentences = _split_sentences(response)
            if idx < len(sentences):
                target = sentences[idx]
                pos = response.find(target)
                if pos > 0 and pos < cut_at:
                    cut_at = pos
        notes.append(f"L4 semantic rep clusters={len(l4.clusters)}")

    final = response[:cut_at].rstrip() if decision in ("cut", "retry") else response
    if decision == "retry":
        final = response[:cut_at].rstrip() if cut_at < len(response) else ""

    retry_suffix = ""
    if decision == "retry":
        retry_suffix = (
            "\n\n[system note: previous generation contained repetition ("
            + ", ".join(n.split(" ", 1)[0] for n in notes)
            + "). Respond differently. Do not repeat phrases.]"
        )

    return RepetitionControllerResult(
        response=final,
        original_chars=len(response),
        final_chars=len(final),
        cut_at=cut_at,
        triggered=decision != "pass",
        decision=decision,
        levels=levels,
        retry_prompt_suffix=retry_suffix,
        new_temperature=new_temp,
        notes=notes,
    )


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _cli() -> int:
    p = argparse.ArgumentParser(description="Nemo repetition controller")
    p.add_argument("--response", required=True, help="path to file with the response")
    p.add_argument("--token-threshold", type=float, default=0.5)
    p.add_argument("--ngram-min", type=int, default=3)
    p.add_argument("--sentence-min", type=int, default=2)
    p.add_argument("--semantic-threshold", type=float, default=0.7)
    p.add_argument("--base-temperature", type=float, default=0.7)
    args = p.parse_args()
    text = Path(args.response).read_text(encoding="utf-8", errors="replace")
    result = control(
        text,
        token_threshold=args.token_threshold,
        ngram_min=args.ngram_min,
        sentence_min=args.sentence_min,
        semantic_threshold=args.semantic_threshold,
        base_temperature=args.base_temperature,
    )
    print(json.dumps(result.to_dict(), ensure_ascii=False, indent=2))
    return 0 if result.decision == "pass" else 2


if __name__ == "__main__":
    sys.exit(_cli())
