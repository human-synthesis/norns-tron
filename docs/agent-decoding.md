# TRON for agents — decoding hints and where each format is used (T-04)

Verdict of the T-04 spike (2026-09-01, run as a real agent session over the
norns-demo CRM specs): **spec views stay in the canonical JSON layout; TRON is
the wire format.** Both are locked.

## The measurement

Five CRM spec files, chars/4 token estimate (the house metric):

| view | chars | est. tokens |
|---|---|---|
| TRON `encode()` | 5,126 | 1,282 |
| canonical layout (`formatCanonical`) | 7,186 | 1,797 |
| minified JSON | 5,419 | 1,355 |

TRON saves **29%** vs the canonical layout and round-trips losslessly on every
file (verified `decode(encode(x)) ≡ x`).

## Why specs still use the JSON layout

- **Comprehension.** TRON hoists repeated object shapes into a class table
  (`class C1: owner,fields,status`) and emits positional constructor calls
  (`C1("owner", {...}, {...})`). Answering "which Deal fields are optional?"
  requires resolving the class table and counting argument positions — a real
  misread risk for exactly the reader (an agent mid-edit) whose mistakes are
  most expensive. The canonical layout needs no decoding.
- **Diff locality.** Adding one field can introduce a new shape, renumber the
  class table, and touch every line that references shifted classes. Canonical
  JSON keeps a one-line change a one-line diff — and git diffs are the human
  review surface (PLAN: no builder app).
- 29% of ~1.8k tokens is ~500 tokens per full spec read; `spec.read` returns
  summaries by default, so the realistic saving is far smaller than the risk.

## Where TRON is on

`route()` responses via `tronSerializer()` — content-negotiated
(`Accept: application/tron`), so JSON clients are unaffected. High-volume row
data is where the class/table encoding shines; that is the 11–61% band in
PERFORMANCE.md.

## Decoding hints (for agents reading TRON wire responses)

1. The header declares vocabularies, one per line, before the body:
   `enum E0: ref` (string pool), `class C3: type` / `class C4: type,optional`
   (shape = ordered key list).
2. The body is JSON except that `Cn(a, b, …)` means "object of shape Cn with
   values bound to its keys *in declared order*" — `C4("date", true)` ⇒
   `{ "type": "date", "optional": true }`.
3. Enum references appear as indices where a class key was declared with
   `@En` — `C2(0, "core.Entity.User")` with `class C2: type@E0,ref` and
   `enum E0: ref` ⇒ `{ "type": "ref", "ref": "core.Entity.User" }`.
4. Objects that match no hoisted shape are emitted as literal JSON inline;
   plain JSON is valid TRON, so when in doubt read it as JSON.
5. Never hand-produce TRON — emit JSON (valid TRON) or use `encode()`.
