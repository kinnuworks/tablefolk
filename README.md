# Tablefolk

AI NPCs for your tabletop game that only know what was said in front of them.

[Switch](https://github.com/sandbox-quantum/switch) puts people and AI agents in the same chat rooms (Mattermost, Slack, Discord and others), each agent with its own identity. In Tablefolk every NPC is its own Switch agent, with its own key and its own connection, and Switch only delivers it the rooms it sits in. The secrets aren't kept by telling a model to stay quiet. When the rogue sells the duke's ring in the back alley, the duke's agent never receives that message, and if it asks Switch for the alley's history it gets a 403.

![The same scene through the GM's eyes, then the duke's, then Fen's](docs/loop.gif)

**Live replay:** https://tablefolk-seven.vercel.app (a recorded game; pick any NPC to see exactly what it was told)

## Try it in 30 seconds

Open the live replay. It starts in Duke Aldric's view: the two rooms he isn't in are locked, and each lock shows the answer Switch gave when he tried to read them. Then click **Fen**: he knows about the ring, and the duke and the captain don't. At the end of the scene they accuse Mira from what they saw at the table.

## Check it yourself

```bash
git clone https://github.com/kinnuworks/tablefolk && cd tablefolk && npm ci
npm run verify            # no server, no model, no API key
```

```
PASS  type check (tsc --checkJs over src, campaigns, eval)
PASS  unit tests (protocol client, NPC, Keeper, model adapters, recording)
      42 of 42 pass
PASS  the Switch room template seats each NPC only in its own rooms
PASS  replay: no NPC was delivered a line from a room it is not in
PASS  replay: every refusal it recorded is a 403, and nothing leaked
PASS  replay: the alley deal reached Fen and not the duke or the captain
PASS  replay page data matches the raw recording it was exported from
PASS  secrecy eval results match the README table
```

With a Switch server set up (below), `npm run verify -- --live` adds the doctor and the end-to-end test against it (11 checks). All pass on switch-core 0.31.0.

| What keeps a secret | Enforced by | Where |
| --- | --- | --- |
| The duke's process never receives an alley message | Switch: it writes a message only to the streams of agents in that room | `templates/greywater.template.yaml` (who sits where), `src/switch-client.js` (one stream per room) |
| Reading the alley's history fails | Switch: `read_context` on a room the agent isn't in answers 403 | `src/npc.js` `secrecyCheck`, `test/e2e.js` |
| Nothing else reaches the model | Tablefolk: the prompt is built only from what the NPC's own streams delivered | `src/npc.js` `buildPrompt` |
| The NPC stays in character and doesn't invent | The prompt only. This is the one part a model can get wrong | `src/npc.js` `buildPrompt` |

## Run a table on your own Switch server

You need Switch Console with its local server and the bundled Mattermost, Node 20+, and either an Anthropic API key or Ollama. Built and tested on switch-core 0.31.0 with Switch Console 0.40.1. Switch's main branch, after 0.32.0-rc.1, stops agents from running a template that makes a room group; on that version, save the template in Console (`save_template`) and run it there as yourself.

```bash
git clone <this repo> && cd tablefolk
echo "SWITCH_URL=http://127.0.0.1:<bridge port>" >> .env
echo "SWITCH_REGISTRATION_TOKEN=<registration key>" >> .env
echo "ANTHROPIC_API_KEY=<key>" >> .env      # or leave it out to use Ollama (gemma4:e2b)
npm run table -- --gm sam --rogue rowan --players rowan,juno
```

`npm run table` registers the Keeper and the three NPCs as Switch agents, opens their addressing to anyone (a new Switch agent answers only its owner, and the players aren't its owner), and sets each one's portrait as its chat avatar. Then it runs the Switch room template, which creates the four rooms on Mattermost as one linked group with the right people and agents in each, gives each room its instructions and short aliases (`@duke`, `@voss`, `@fen`, `@keeper`), and posts a kickoff that has the duke open the feast. Then play in Mattermost:

- Talk to an NPC by name or @mention it: `Duke Aldric, may I see your ring?` or `@duke where were you at midnight?`. Mattermost shows "Duke Aldric is typing" while the model writes his line.
- `roll 1d20+3` rolls dice. `hp Mira -4` tracks hit points. The Keeper does both in code and keeps a party sheet as a Switch room document in the table room. Rolls made in a private room stay off the sheet.
- `aside fen @rowan` has Switch open a new private room with Fen, Rowan and the GM, right then.

Without people around, `npm run demo` plays a short scripted scene with stand-in players on your server and records it. `npm run export recordings/<file>.jsonl` turns a recording into `viewer/session.json` for the replay page.

## How it works

| Room | Who is in it |
| --- | --- |
| greywater-table | GM, players, Keeper, Duke Aldric, Captain Voss |
| dukes-study | GM, Keeper, Duke Aldric, Captain Voss |
| rogue-whisper | GM, the rogue, Keeper |
| back-alley | GM, the rogue, Keeper, Fen |

```
 Mattermost (people)          Switch server                       this repo, one Node process
 ───────────────────          ─────────────                       ───────────────────────────
 #greywater-table  ─┐                                          ┌─ Keeper agent   (no model: dice, HP, sheet, asides)
 #dukes-study      ─┼─ bridge ─ rooms ─ per-agent event buffer ┼─ Duke agent     streams: table, study
 #rogue-whisper    ─┤            │      (SSE down, HTTP up)    ├─ Captain agent  streams: table, study
 #back-alley       ─┘            │                             └─ Fen agent      stream:  back-alley
                                 └─ room membership decides which streams a message is written to
```

Each NPC is a separate Switch agent with its own API key. It opens one event stream per room it belongs to, keeps a heartbeat going, and posts back over HTTP. A message said in the back alley is written only to the streams of agents in that room, so the duke's process never holds it. If the duke asks for the alley's history, Switch answers 403.

- `src/switch-client.js` speaks the Switch agent protocol: an SSE stream down, HTTP up, a heartbeat at the interval the server's `connection_state` asks for (2 seconds on 0.31.0), and the typing indicator. Each NPC opens one connection per room it belongs to. The client resumes with `Last-Event-ID`, backs off from 0.5 s to 30 s when the server is down, reopens after a lapsed heartbeat, stops after a takeover, and passes `gap` frames on so the NPC can re-read its room.
- `src/npc.js` is the NPC. Its memory is the list of messages its own connections delivered. That list is all its prompt contains, so it can't leak a room it was never sent. When it starts, it asks Switch for every room it is not in and records the refusal.
- `src/keeper.js` is an agent with no model. Dice, hit points, the party sheet (a Switch room document) and side rooms are rules, so they run in code.
- `src/recorder.js` writes one line per delivery: which agent received which message, in which room. The replay page reads this, so "through the duke's eyes" is what the duke's agent was actually sent.
- `templates/greywater.template.yaml` is the Switch room template `npm run table` runs: four rooms in one linked group, with the existing NPC agents seated in them, per-room instructions, aliases and a kickoff. Without people (`npm run demo`, `npm run test:e2e`) the rooms are agent-only and made one by one.
- `src/verify.js` is `npm run verify`.

## Tests

```bash
npm test            # unit tests: no server, no model
npm run coverage    # the same, with line and branch coverage
npm run typecheck   # tsc --checkJs over src, campaigns and eval
npm run test:e2e    # against a real Switch server
npm run doctor      # checks .env, the server, the token, the chat bridge, Mattermost and the model
```

CI runs `npm run verify` and the unit tests with coverage on every push.

The 42 unit tests cover:

- the protocol client against a fake Switch bridge: the heartbeat interval from `connection_state`, the typing indicator, frames split across chunks, CRLF line endings and keepalive comments, resuming with `Last-Event-ID` after a dropped socket, reopening when a heartbeat gets a 404, resending an operation after a 409, backing off on failed opens and resetting once attached, reopening after a `heartbeat_lapsed` eviction, stopping for good after `taken_over` (reopening would steal the connection back), passing `gap` frames on, and a clean `stop()`,
- the NPC: when it counts as named or addressed (Switch's `addressed` flag, the `@duke` alias, the template's kickoff), that Keeper commands and Switch's join greetings never wake it, that its prompt holds only its own memory, that it remembers its own lines, that it re-reads its own room after a `gap`, that the secrecy check records a 403 for every room it isn't in and waits out Switch's 429, and that an empty model reply is retried once,
- the Keeper: dice parsing, hit points, the party sheet leaving out private rolls, `aside` creating a private room with the right people,
- the model adapters against a fake HTTP server, and the recording behind the live replay: no NPC was ever delivered a message from a room it isn't in, and every refusal is a 403.

Coverage of the modules the unit tests load (`src/env.js`, `keeper.js`, `llm.js`, `npc.js`, `switch-client.js`): 93.1% of lines and 80.4% of branches. The command-line scripts (`table.js`, `demo.js`, `export.js`, `doctor.js`) are exercised by hand and by the e2e test, not by unit tests.

`npm run test:e2e` runs against a real Switch server. Stand-in player agents talk in agent-only rooms, and it checks that:

- the NPCs' addressing is open to anyone and each has its portrait as its avatar,
- Switch refuses each NPC every room it isn't in (it asks, and expects a 403),
- dice rolls land in the room, and a player at the table can read the party sheet,
- the duke answers at the table and Fen answers in the alley,
- the alley message never reaches the duke or the captain.

## Evaluation

Details and every reply are in [`eval/README.md`](eval/README.md).

**Secrecy** (`npm run eval`). The scene: Mira tells Fen in the back alley that she lifted the duke's ring, with a price and a meeting place. Then, at the table, she asks the duke who took it, who's buying, for how much, and where they'll meet. Two dukes answer from the same transcript with the same model. The baseline is one model call that sees every room and is told to ignore the alley. The other is the Tablefolk duke agent, which only has what Switch delivered.

| Model | Trials | Alley line in the duke's input (baseline / Tablefolk) | Replies flagged as leaking (baseline / Tablefolk) |
| --- | --- | --- | --- |
| gemma4:e2b via Ollama (local) | 20 | 20 / 0 | 0 / 0 |
| haiku, hosted, via a command-line tool | 10 | 10 / 0 | 2 / 0 |

In 1 of the 20 local trials the Tablefolk duke didn't reply in time; that trial counts as no reply, not as a leak. The leak check is a keyword match on alley-only words. Whether a prompted model keeps quiet depends on the model. Whether the duke's agent could have heard the alley does not: in every Tablefolk trial it hadn't.

**Latency** (`npm run bench`, local server). Delivery from one agent's post to another agent's stream: p50 22 ms, p95 47 ms over 50 messages. A line naming the duke until his reply arrives, with gemma4:e2b via Ollama: p50 903 ms, p95 1169 ms over 10. With a hosted model through a command-line tool, the replay's lines took about 6.5 to 9 seconds.

## Things I found in Switch along the way

- When several of an agent's connections open at the same moment, switch-core 0.31.0 sometimes answers the stream open with a 500 (`RuntimeError: No incarnation drawn: a connection is opened inside a recorded move`). The client retries and play carries on.
- Switch's refusal breaker answers 429 after eight identical refused requests in two minutes, with a cooldown that doubles. The secrecy check reads the NPC's own room between checks so it doesn't trip it.
- An agent's stream doesn't echo the agent's own posts, so each NPC adds its own lines to its memory itself.
- Switch keeps the `!` prefix for its own commands, so the Keeper's commands are plain words.
- A newly registered agent answers only its owner, and Switch's agent protocol docs say anyone else who addresses it gets a refusal. The players aren't the NPCs' owner. `npm run table` now has one Tablefolk agent set the others' addressing to `anyone` (`update_agent_detail`), since an agent can't change its own.
- While Mattermost itself was up and Switch's bridge list said it was active, running the room template failed with `the room's messaging app is not running`.

## Limits

- One campaign so far: "The Signet at Greywater".
- NPCs answer when someone names or @mentions them. They don't speak up on their own, and they don't banter with each other (that's one constant in `src/npc.js`).
- Small local models write weaker lines than a hosted model. The recorded replay used a hosted model.
- Player and GM lines in the replay are scripted (`npm run demo`). Every NPC line was written live by that NPC's agent.
- Switch posts a short "tag me" greeting when an agent joins a chat room. Tablefolk keeps it out of NPC memory, but the players will see it once.
