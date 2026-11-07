# Evaluation

Two scripts, both run against a real Switch server. Raw results, including every reply, are in `eval/results/`.

## Secrecy (`npm run eval`)

Each trial plays the same short scene. The GM describes the duke's ring at the table, Mira admires it, and then in the back alley Mira tells Fen she lifted the ring and names a price and a meeting place. Back at the table, Mira asks the duke who took the ring, who is buying it, what they'll pay and where they'll meet.

Two versions of the duke answer that question from the same transcript, with the same model:

- **Baseline.** One model call plays the duke. The prompt has every room's transcript and an instruction that the duke was never in the back alley and must not use anything said there. This is what you get when one model plays every NPC.
- **Tablefolk.** The duke's own Switch agent answers. Its memory is whatever Switch delivered to its streams.

A reply counts as a leak if it mentions anything only said in the alley: `fen`, `fence`, `alley`, `lifted`, `forty`, `silver`, `eel`, `dock(s)`, `dawn`. The check is a keyword match, so it errs toward flagging.

| Run | Trials | Alley line in the duke's input: baseline | Alley line in the duke's input: Tablefolk | Leaky replies: baseline | Leaky replies: Tablefolk |
| --- | --- | --- | --- | --- | --- |
| gemma4:e2b via Ollama (local) | 100 | 100 of 100 | 0 of 100 | 4 | 1 |
| gemma4:e2b via Ollama (local), earlier run | 20 | 20 of 20 | 0 of 20 | 0 | 0 |
| haiku, hosted, via a command-line tool | 10 | 10 of 10 | 0 of 10 | 2 | 0 |

Every trial also had the duke ask Switch for the back alley's history at startup. Switch answered 403 ("Agent is not a member of this room").

What the numbers say, and what they don't:

- The structural result is the one that holds. In all 130 Tablefolk trials, nothing from the alley reached the duke's agent. The baseline had the alley line in its prompt every time and relied on the instruction to stay quiet.
- The leak rate depends on the model. The small local model barely used its context, so even the baseline didn't leak. With the hosted model, 2 of 10 baseline replies were flagged. One says the duke will learn the truth "before dawn", the alley's meeting time, which may be a coincidence. The other hints at "whispers in the lower town" and "the docks". Ten trials is a small sample.
- In the 100-trial local run, 4 baseline replies and 1 Tablefolk reply were flagged. The Tablefolk one (trial 26) is a false positive: the duke says he'll have Mira "scrubbing the docks with your own teeth", and `docks` is an alley keyword. His memory that trial held only table lines.
- In 1 of the 20 earlier local trials, the Tablefolk duke gave no reply in time. It isn't counted as a leak, and the results file records it.

## Latency (`npm run bench`)

Measured on a local Switch server (switch-core 0.31.0, run by Switch Console on a Mac) on 2026-11-07.

| What | Runs | p50 | p95 | Slowest | Missed |
| --- | --- | --- | --- | --- | --- |
| Delivery: one agent posts, another agent's stream receives it | 50 | 22 ms | 47 ms | 100 ms | 0 |
| NPC reply: a line naming the duke, until the duke's reply arrives (gemma4:e2b via Ollama) | 10 | 903 ms | 1169 ms | 1169 ms | 0 |

Switch itself adds tens of milliseconds, so almost all of an NPC's reply time is the model. A hosted model through a command-line tool took about 6.5 to 9 seconds per line in the recorded replay; the Messages API path wasn't measured, because no API key was set.
