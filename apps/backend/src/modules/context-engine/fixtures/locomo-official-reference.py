#!/usr/bin/env python3
"""Dependency-free reference for LoCoMo commit 3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376."""
import collections
import json
import re
import string
import sys


def normalize(value):
    value = value.replace(",", "").lower()
    value = "".join(ch for ch in value if ch not in set(string.punctuation))
    value = re.sub(r"\b(a|an|the|and)\b", " ", value)
    return " ".join(value.split())


# This is the original Porter algorithm used by NLTK's default PorterStemmer mode.
def stem(word):
    irregular = {"sky":"sky","skies":"sky","dying":"die","lying":"lie","tying":"tie","news":"news","innings":"inning","inning":"inning","outings":"outing","outing":"outing","cannings":"canning","canning":"canning","howe":"howe","proceed":"proceed","exceed":"exceed","succeed":"succeed"}
    word = word.lower()
    if word in irregular: return irregular[word]
    if len(word) <= 2: return word
    def consonant(text, i):
        if text[i] in "aeiou": return False
        if text[i] == "y": return True if i == 0 else not consonant(text, i - 1)
        return True
    def measure(text):
        return sum(consonant(text, i) and not consonant(text, i - 1) for i in range(1, len(text)))
    def has_vowel(text): return any(not consonant(text, i) for i in range(len(text)))
    def cvc(text):
        i = len(text) - 1
        if len(text) == 2: return not consonant(text, 0) and consonant(text, 1)
        return len(text) >= 3 and consonant(text, i) and not consonant(text, i - 1) and consonant(text, i - 2) and text[i] not in "wxy"
    def replace(value, suffix, replacement, minimum=0):
        stemmed = value[:-len(suffix)] if suffix else value
        return stemmed + replacement if value.endswith(suffix) and measure(stemmed) > minimum else value
    if word.endswith("ies") and len(word) == 4: word = word[:-3] + "ie"
    elif word.endswith("sses"): word = word[:-2]
    elif word.endswith("ies"): word = word[:-2]
    elif word.endswith("ss"): pass
    elif word.endswith("s"): word = word[:-1]
    if word.endswith("ied"): word = word[:-3] + ("ie" if len(word) == 4 else "i")
    elif word.endswith("eed"): word = replace(word, "eed", "ee")
    else:
        suffix = "ed" if word.endswith("ed") else "ing" if word.endswith("ing") else None
        if suffix and has_vowel(word[:-len(suffix)]):
            word = word[:-len(suffix)]
            if word.endswith(("at", "bl", "iz")): word += "e"
            elif re.search(r"([^aeiou])\1$", word) and word[-1] not in "lsz": word = word[:-1]
            elif measure(word) == 1 and cvc(word): word += "e"
    if word.endswith("y") and len(word) > 2 and consonant(word[:-1], len(word) - 2): word = word[:-1] + "i"
    step2 = [("ational","ate"),("tional","tion"),("enci","ence"),("anci","ance"),("izer","ize"),("bli","ble"),("alli","al"),("entli","ent"),("eli","e"),("ousli","ous"),("ization","ize"),("ation","ate"),("ator","ate"),("alism","al"),("iveness","ive"),("fulness","ful"),("ousness","ous"),("aliti","al"),("iviti","ive"),("biliti","ble"),("fulli","ful")]
    changed = True
    while changed:
        changed = False
        for suffix, replacement in step2:
            updated = replace(word, suffix, replacement)
            if updated != word:
                word, changed = updated, suffix == "alli"
                break
        else:
            if word.endswith("logi") and measure(word[:-3]) > 0: word = word[:-4] + "log"
    for suffix, replacement in [("icate","ic"),("ative",""),("alize","al"),("iciti","ic"),("ical","ic"),("ful",""),("ness","")]:
        updated = replace(word, suffix, replacement)
        if updated != word: word = updated; break
    for suffix in ["al","ance","ence","er","ic","able","ible","ant","ement","ment","ent","ion","ou","ism","ate","iti","ous","ive","ize"]:
        if word.endswith(suffix):
            base = word[:-len(suffix)]
            if measure(base) > 1 and (suffix != "ion" or base.endswith(("s", "t"))): word = base
            break
    if word.endswith("e"):
        base = word[:-1]
        if measure(base) > 1 or (measure(base) == 1 and not cvc(base)): word = base
    if word.endswith("ll") and measure(word) > 1: word = word[:-1]
    return word


def token_f1(prediction, answer):
    predicted = [stem(word) for word in normalize(prediction).split()]
    expected = [stem(word) for word in normalize(answer).split()]
    common = collections.Counter(predicted) & collections.Counter(expected)
    overlap = sum(common.values())
    if overlap == 0: return 0.0
    precision, recall = overlap / len(predicted), overlap / len(expected)
    return 2 * precision * recall / (precision + recall)


def score(row):
    category, prediction, answer = row["category"], row["prediction"], str(row["answer"])
    if category == 3: answer = answer.split(";")[0].strip()
    if category in (2, 3, 4): return token_f1(prediction, answer)
    if category == 1:
        predictions = [part.strip() for part in prediction.split(",")]
        answers = [part.strip() for part in answer.split(",")]
        return sum(max(token_f1(part, expected) for part in predictions) for expected in answers) / len(answers)
    if category == 5: return 1.0 if "no information available" in prediction.lower() or "not mentioned" in prediction.lower() else 0.0
    raise ValueError("invalid category")


rows = json.load(open(sys.argv[1], encoding="utf-8"))
scores = [{"id": row["id"], "score": round(score(row) + 1e-12, 3)} for row in rows]
categories = {str(category): {"count": len(selected), "score": sum(item["score"] for item in selected) / len(selected) if selected else 0.0} for category in range(1, 6) for selected in [[item for item, row in zip(scores, rows) if row["category"] == category]]}
print(json.dumps({"scores": scores, "categories": categories, "overall": sum(item["score"] for item in scores) / len(scores)}))
