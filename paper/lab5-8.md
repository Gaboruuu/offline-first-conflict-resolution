# Lab 5-8 report: requirements and deliverables

Research project (UBB Cluj, "Proiect de cercetare"): *Conflict Resolution Strategies for Offline-First Mobile
Applications: An Empirical Comparison of Last-Write-Wins, Vector Clocks and CRDTs*.
Repository: `github.com/Gaboruuu/offline-first-conflict-resolution`. Hand-in: 19 November 2026.

The article is in `paper/` (LaTeX, `amsart` + the Studia UBB Informatica package, English). Section numbers below
refer to `paper/main.pdf`.

## Requirement 1: experimental modelling, mathematical model, choice of technologies

| What | Where |
|---|---|
| Formal model: replicas, operations, happens-before, strategies, convergence | Section 4.1, Definitions 4.1-4.5 (`paper/sections/model.tex`) |
| Outcome of an operation (preserved, superseded, surfaced, lost, ambiguous) and the metrics | Section 4.2, Definitions 4.6-4.7, Table 3 |
| The strategies S1-S4 and the type-aware hybrid; convergence of S4 (Proposition 4.8) | Sections 4.3-4.4 |
| Test bench, technology choices with the alternatives not chosen | Sections 5.1-5.2, Table 4 (`paper/sections/setup.tex`) |
| Experiments E1-E6, validation method (30 seeds, 95% CI, Mann-Whitney U with Holm correction) | Sections 5.3-5.4, Table 5 |
| Code of the model | `packages/sync-core/src/` (`model.ts`, `ops.ts`, `strategy.ts`, `clock/`, `crdt/`, `strategies/`) |
| Code of the oracle and metrics | `sim/src/oracle.ts`, `sim/src/causality.ts`, `sim/src/aggregate.ts` |

## Requirement 2: case study on a small dataset, with code

| What | Where |
|---|---|
| Section of the article | Section 6 (`paper/sections/casestudy.tex`), Tables 6-8, Figure 1 |
| Dataset (6 subscriptions, 3 clients) | `sim/scenarios/case-study/dataset.json` |
| Six scripted scenarios C1-C6 | `sim/scenarios/case-study/C*.json` |
| Small random workload (5 seeds) | `sim/experiments/case-study.json` |
| Run: `npm run case-study` (in `sim/`) | `sim/src/caseStudy.ts`, output in `sim/out/case-study/` |
| Tables and figure data of the article: `npm run tables` (in `sim/`) | `sim/scripts/tables.ts` writes `paper/generated/` |
| Expected outcomes checked by tests | `sim/test/caseStudy.test.ts` |

## Requirement 3: related work and preparation of the validation on real data

| What | Where |
|---|---|
| Related Work: optimistic replication (Coda, Bayou, Dynamo), CRDT implementations and their cost, mobile sync frameworks (Automerge, Yjs, WatermelonDB), gap analysis, expectations table | Section 3 (`paper/sections/related.tex`), Table 1 |
| Validation plan: public `crdt-benchmarks` workloads (incl. a real editing trace) replayed through the Automerge and Yjs adapters; subset of C1-C6 replayed on two emulators and one phone | Section 5.5 |
| Bibliography (31 entries, BibTeX, style `acm`, URLs) | `paper/refs.bib` |

## Requirement 4: code and document in git, with a steady history

All work is on GitHub, one branch per phase, each merged through a pull request:

| Branch | Content |
|---|---|
| `main` (initial) | import of the app and server, CI, Docker |
| `feature/sync-core` | data model, operations, codec, clocks |
| `feature/strategies` | S1 LWW, S2 version vectors, S3 Automerge and Yjs, registry, conformance suite |
| `feature/sync-server` | SQLite storage, strategy-agnostic `POST /sync`, Docker images |
| `feature/simulator` | deterministic simulator, workloads, oracle, aggregation |
| `feature/case-study` | dataset, scenarios C1-C6, random workload, results |
| `feature/hybrid` | CRDT building blocks and the hybrid strategy S4 |
| `feature/app-sync` | the app on top of the strategies: model, persistence, sync repository, conflict screen, developer settings |
| `paper/lab5-8` | this article and report |

`git log --oneline` shows one commit per task, from 12 to 19 November 2026.

## Deployment

- Server: Docker image built from the repository root, `docker compose up --build server` (port 3000, SQLite in a
  volume, strategy chosen with `STRATEGY=lww|vv|automerge|yjs|hybrid`).
- App: Expo / React Native. It ships the strategies `lww`, `vv`, `yjs` and `hybrid`; Automerge is evaluated only in
  the simulator and on the server, because Hermes does not run WebAssembly. An Android APK can be built with EAS
  (`eas build -p android --profile preview`); the developer screen (long press on the title) selects the strategy,
  clock skew and offline mode.

## Building the article

```
cd paper
latexmk -pdf main.tex
```

With MiKTeX on Windows: `pdflatex main`, `bibtex main`, `pdflatex main`, `pdflatex main`. The build has no errors or
warnings and the article has 16 pages.

## Still to do (after the hand-in)

Phase 9 (harness validation on public data), Phase 10 (experiments E1-E6 with 30 seeds, Results and Discussion
sections) and Phase 11 (replay on devices). The hybrid's server state (above LWW and Automerge in the case study) is
the first optimisation target. The institutional e-mail address in `paper/main.tex` is still a placeholder.
